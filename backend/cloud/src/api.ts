import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import {
  assignmentCreateSchema,
  homeCreateSchema,
  homeUpdateSchema,
  hubRegisterSchema,
  loginSchema,
  passwordChangeSchema,
  platformScope,
  setupSchema,
  staffCreateSchema,
  staffUpdateSchema,
  type HubEnrolment,
  type MeView,
  type PlatformScope,
} from '@voltax/contracts';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { CloudAudit } from './audit.js';
import { CloudError, badRequest, forbidden, notFound } from './errors.js';
import { assertCloudGuarded, type CloudGuard } from './guard.js';
import type { HomesService } from './homes.js';
import { view, type Authenticated, type StaffService } from './staff.js';

export const SESSION_COOKIE = 'voltax_session';
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_PER_WINDOW_DEFAULT = 10;
const UNAUTH_AUDIT_INTERVAL_MS = 60_000;

export interface CloudApiConfig {
  /** Secure cookies (HTTPS). Only false for local plain-HTTP development and tests. */
  cookieSecure: boolean;
  /** e.g. https://admin.voltex.example; state-changing requests from another Origin are refused. */
  publicOrigin?: string;
  /** Given to installers with a hub credential (CLOUD_URL for the hub). */
  brokerUrl?: string;
  commandPublicKeyPem?: string;
  /** Address(es) of the reverse proxy whose X-Forwarded-For is trusted (Caddy). Default: none. */
  trustProxy?: string | false;
  /** Login and setup attempts per client IP per minute. */
  loginLimitPerMinute?: number;
  /** Static export of frontend/admin, served on the API's origin (same-origin cookies, no CORS). */
  uiDir?: string;
  /**
   * Local launcher only: pages (the home app) that may send a staff sign-in straight to
   * POST /api/v1/auth/login, so one sign-in page serves homeowners and staff. Nothing else is
   * opened cross-origin. Never set for real homes: staff must not type passwords on a home hub's page.
   */
  signInOrigins?: string[];
}

const LOGIN_ROUTE = '/api/v1/auth/login';

// Portal pages: same-origin everything. Inline scripts/styles are the Next.js static export's
// bootstrap data and the theme snippet; nothing is loaded from another origin.
const UI_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export interface CloudApiDeps {
  audit: CloudAudit;
  staff: StaffService;
  homes: HomesService;
  config: CloudApiConfig;
  /** Full audit verification (chain + signed checkpoints). Defaults to the chain only. */
  verifyAudit?: () => Promise<{ ok: boolean }>;
  /** Feature modules (grants, fleet, notifications) register their routes here; same guard rules. */
  plugins?: Array<(app: FastifyInstance) => Promise<void> | void>;
}

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value ?? {});
  if (!result.success) throw badRequest(result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return result.data;
}

const uuid = z.uuid();

/** Staff id of the signed-in caller. Only valid inside guarded handlers. */
export function staffIdOf(req: FastifyRequest): string {
  if (!req.auth) throw new CloudError(401, 'unauthorized');
  return req.auth.staff.id;
}

export async function buildCloudApi(deps: CloudApiDeps, serverOptions: FastifyServerOptions = {}): Promise<FastifyInstance> {
  const { audit, staff, homes, config } = deps;
  const app = Fastify({ trustProxy: config.trustProxy ?? false, bodyLimit: 256 * 1024, ...serverOptions });
  const guards: Array<{ method: string; url: string; guard: CloudGuard }> = [];
  app.decorate('routeGuards', guards);
  app.decorateRequest('auth', undefined);
  app.decorateRequest('scope', undefined);
  // JSON only: a cross-site form post (text/plain, urlencoded) cannot reach a handler.
  app.removeContentTypeParser('text/plain');

  // Shared sign-in page (signInOrigins): CORS for the login route only, for the listed origins only.
  const signInOrigin = (req: FastifyRequest): string | undefined => {
    const origin = req.headers.origin;
    return origin && req.url === LOGIN_ROUTE && config.signInOrigins?.includes(origin) ? origin : undefined;
  };
  app.addHook('onRequest', async (req, reply) => {
    const origin = signInOrigin(req);
    if (!origin) return;
    reply.header('access-control-allow-origin', origin).header('access-control-allow-credentials', 'true').header('vary', 'Origin');
    if (req.method === 'OPTIONS') {
      return reply.status(204).header('access-control-allow-methods', 'POST').header('access-control-allow-headers', 'content-type').header('access-control-max-age', '600').send();
    }
  });

  app.addHook('onRoute', (route) => {
    const guard = (route.config as { guard?: CloudGuard } | undefined)?.guard;
    for (const method of [route.method].flat()) {
      assertCloudGuarded(method, route.url, guard);
      if (guard && route.url.startsWith('/api/') && method !== 'HEAD') guards.push({ method, url: route.url, guard });
    }
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    if (req.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
    else reply.header('content-security-policy', UI_CSP);
    if (config.cookieSecure) reply.header('strict-transport-security', 'max-age=31536000');
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof CloudError) return reply.status(err.status).send({ error: err.code, message: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return reply.status(status).send({ error: 'bad_request', message: (err as Error).message });
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'internal', message: 'internal error' });
  });

  // --- authentication and authorisation (deny-by-default) ----------------------------------------

  let lastUnauthAudit = 0;
  const unauthorised = async (req: FastifyRequest, reply: FastifyReply) => {
    if (Date.now() - lastUnauthAudit > UNAUTH_AUDIT_INTERVAL_MS) {
      lastUnauthAudit = Date.now();
      await audit.append({ actor: `ip:${req.ip}`, action: 'auth.session', outcome: 'denied', target: `${req.method} ${req.routeOptions.url}` });
    }
    return reply.status(401).send({ error: 'unauthorized', message: 'sign in again' });
  };

  const deny = async (req: FastifyRequest, reply: FastifyReply, status: 403 | 404, reason: string, homeId?: string) => {
    await audit.append({
      actor: `staff:${req.auth!.staff.id}`,
      action: 'authz.denied',
      outcome: 'denied',
      target: `${req.method} ${req.routeOptions.url}`,
      homeId: homeId && uuid.safeParse(homeId).success ? homeId : null,
      details: { role: req.auth!.staff.role, reason },
    });
    return status === 404 ? reply.status(404).send({ error: 'not_found', message: 'not found' }) : reply.status(403).send({ error: 'forbidden', message: reason });
  };

  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    const guard = (req.routeOptions.config as { guard?: CloudGuard } | undefined)?.guard;
    if (!guard) return reply.status(404).send({ error: 'not_found', message: 'not found' }); // unknown /api path
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !sameOrigin(req, config.publicOrigin) && !signInOrigin(req)) {
      return reply.status(403).send({ error: 'forbidden', message: 'cross-origin request refused' });
    }
    if ('public' in guard) return;

    const auth = await staff.authenticate(readCookie(req.headers.cookie, SESSION_COOKIE));
    if (!auth) return unauthorised(req, reply);
    req.auth = auth;
    if ('session' in guard) {
      return;
    }

    const scope = platformScope(auth.staff.role, guard.action);
    if (!scope) return deny(req, reply, 403, `${auth.staff.role} may not ${guard.action}`);
    req.scope = scope;
    if (!guard.home) return;

    const source = guard.home === 'params' ? req.params : guard.home === 'query' ? req.query : req.body;
    const homeId = (source as { homeId?: unknown } | undefined)?.homeId;
    // Unknown, malformed and unassigned homes all look the same: not found.
    if (typeof homeId !== 'string' || !uuid.safeParse(homeId).success) return deny(req, reply, 404, 'invalid home id');
    if (scope === 'platform' || scope === 'own') {
      if (!(await homes.exists(homeId))) return reply.status(404).send({ error: 'not_found', message: 'not found' });
      return;
    }
    if (!(await homes.isAssigned(auth.staff.id, homeId))) return deny(req, reply, 404, 'not assigned to this home', homeId);
  });

  // --- public ----------------------------------------------------------------------------------

  app.get('/api/v1/health', { config: { guard: { public: true } } }, async () => ({ ok: true }));

  const loginAttempts = new Map<string, { windowStart: number; count: number }>();
  const limitLogin = (ip: string) => {
    const now = Date.now();
    const entry = loginAttempts.get(ip);
    if (!entry || now - entry.windowStart > LOGIN_WINDOW_MS) {
      loginAttempts.set(ip, { windowStart: now, count: 1 });
      if (loginAttempts.size > 10_000) loginAttempts.clear();
      return;
    }
    if (++entry.count > (config.loginLimitPerMinute ?? LOGIN_PER_WINDOW_DEFAULT)) throw new CloudError(429, 'rate_limited', 'too many attempts, wait a minute');
  };

  app.post('/api/v1/auth/login', { config: { guard: { public: true } } }, async (req, reply) => {
    limitLogin(req.ip);
    const body = parse(loginSchema, req.body);
    const { token, staff: s } = await staff.login(body.email, body.password, req.ip);
    setSessionCookie(reply, token, config.cookieSecure);
    return { staff: s };
  });

  app.post('/api/v1/auth/setup', { config: { guard: { public: true } } }, async (req, reply) => {
    limitLogin(req.ip);
    const body = parse(setupSchema, req.body);
    const { token, staff: s } = await staff.completeSetup(body.token, body.password);
    setSessionCookie(reply, token, config.cookieSecure);
    return { staff: s };
  });

  // --- own session -------------------------------------------------------------------------------

  app.get('/api/v1/auth/me', { config: { guard: { session: 'self' } } }, async (req): Promise<MeView> => {
    const auth = req.auth as Authenticated;
    return { staff: view(auth.staff), mfa: auth.session.mfa, sessionExpiresAt: auth.session.expiresAt };
  });

  app.post('/api/v1/auth/logout', { config: { guard: { session: 'self' } } }, async (req, reply) => {
    await staff.logout((req.auth as Authenticated).session);
    clearSessionCookie(reply, config.cookieSecure);
    return { ok: true };
  });

  app.post('/api/v1/auth/password', { config: { guard: { session: 'self' } } }, async (req) => {
    const body = parse(passwordChangeSchema, req.body);
    await staff.changePassword(req.auth as Authenticated, body.current, body.next);
    return { ok: true };
  });

  // --- staff -------------------------------------------------------------------------------------

  app.get('/api/v1/staff', { config: { guard: { action: 'staff.read' } } }, async () => staff.list());

  app.post('/api/v1/staff', { config: { guard: { action: 'staff.manage' } } }, async (req, reply) => {
    const body = parse(staffCreateSchema, req.body);
    const created = await staff.create(body, staffIdOf(req));
    return reply.status(201).send(created);
  });

  app.get('/api/v1/staff/:staffId', { config: { guard: { action: 'staff.read' } } }, async (req) => staff.get(idParam(req, 'staffId')));

  app.patch('/api/v1/staff/:staffId', { config: { guard: { action: 'staff.manage' } } }, async (req) =>
    staff.update(idParam(req, 'staffId'), parse(staffUpdateSchema, req.body), staffIdOf(req)),
  );

  app.post('/api/v1/staff/:staffId/reset', { config: { guard: { action: 'staff.manage' } } }, async (req) =>
    staff.resetCredentials(idParam(req, 'staffId'), staffIdOf(req)),
  );

  // --- assignments -------------------------------------------------------------------------------

  app.get('/api/v1/assignments', { config: { guard: { action: 'assignment.manage' } } }, async (req) => {
    const q = parse(z.object({ staffId: z.uuid().optional(), homeId: z.uuid().optional() }), req.query);
    return homes.listAssignments(q);
  });

  app.post('/api/v1/assignments', { config: { guard: { action: 'assignment.manage' } } }, async (req, reply) => {
    const body = parse(assignmentCreateSchema, req.body);
    return reply.status(201).send(await homes.assign(body, staffIdOf(req)));
  });

  app.delete('/api/v1/assignments/:assignmentId', { config: { guard: { action: 'assignment.manage' } } }, async (req) => {
    await homes.unassign(idParam(req, 'assignmentId'), staffIdOf(req));
    return { ok: true };
  });

  // --- homes and hubs ----------------------------------------------------------------------------

  app.get('/api/v1/homes', { config: { guard: { action: 'home.read', list: true } } }, async (req) =>
    homes.list(staffIdOf(req), req.scope === 'platform' ? 'platform' : 'assigned'),
  );

  app.post('/api/v1/homes', { config: { guard: { action: 'home.create' } } }, async (req, reply) => {
    const body = parse(homeCreateSchema, req.body);
    return reply.status(201).send(await homes.create(body, staffIdOf(req)));
  });

  app.get('/api/v1/homes/:homeId', { config: { guard: { action: 'home.read', home: 'params' } } }, async (req) => homes.get(homeIdOf(req)));

  app.patch('/api/v1/homes/:homeId', { config: { guard: { action: 'home.update', home: 'params' } } }, async (req) =>
    homes.update(homeIdOf(req), parse(homeUpdateSchema, req.body), staffIdOf(req)),
  );

  app.delete('/api/v1/homes/:homeId', { config: { guard: { action: 'home.delete', home: 'params' } } }, async (req, reply) => {
    await homes.remove(homeIdOf(req), staffIdOf(req));
    return reply.status(204).send();
  });

  app.get('/api/v1/homes/:homeId/contact', { config: { guard: { action: 'home.contact.read', home: 'params' } } }, async (req) => {
    const homeId = homeIdOf(req);
    await audit.append({ actor: `staff:${staffIdOf(req)}`, action: 'home.contact.read', outcome: 'allowed', target: `home:${homeId}`, homeId });
    return homes.contact(homeId);
  });

  app.get('/api/v1/homes/:homeId/hub', { config: { guard: { action: 'hub.read', home: 'params' } } }, async (req) => {
    const home = await homes.get(homeIdOf(req));
    if (!home.hub) throw notFound();
    return home.hub;
  });

  app.post('/api/v1/homes/:homeId/hub', { config: { guard: { action: 'hub.register', home: 'params' } } }, async (req, reply): Promise<HubEnrolment> => {
    const body = parse(hubRegisterSchema, req.body);
    const enrolment = await homes.registerHub(homeIdOf(req), body.hubId, staffIdOf(req));
    reply.status(enrolment.rotated ? 200 : 201);
    return { ...enrolment, brokerUrl: config.brokerUrl ?? null, commandPublicKeyPem: config.commandPublicKeyPem ?? null };
  });

  app.get('/api/v1/homes/:homeId/devices', { config: { guard: { action: 'device.read', home: 'params' } } }, async (req) => homes.devices(homeIdOf(req)));

  // --- audit -------------------------------------------------------------------------------------

  app.get('/api/v1/audit', { config: { guard: { action: 'audit.read' } } }, async (req) => {
    const q = parse(
      z.object({ afterSeq: z.coerce.number().int().min(0).optional(), homeId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(500).optional() }),
      req.query,
    );
    return audit.list(q);
  });

  app.post('/api/v1/audit/verify', { config: { guard: { action: 'audit.verify' } } }, async (req) => {
    const result = await (deps.verifyAudit ?? (() => audit.verify()))();
    await audit.append({ actor: `staff:${staffIdOf(req)}`, action: 'audit.verify', outcome: result.ok ? 'ok' : 'error', details: { ok: result.ok } });
    return result;
  });

  for (const plugin of deps.plugins ?? []) await plugin(app);

  // Company portal. Its wildcard route sits under the /api guard above: an unknown /api path
  // still gets the JSON 404, never a page. redirect: /staff -> /staff/.
  if (config.uiDir && existsSync(config.uiDir)) {
    await app.register(fastifyStatic, { root: config.uiDir, prefix: '/', redirect: true });
  }
  return app;
}

function idParam(req: FastifyRequest, name: string): string {
  const value = (req.params as Record<string, unknown>)[name];
  if (typeof value !== 'string' || !uuid.safeParse(value).success) throw notFound();
  return value;
}

/** Validated by the guard before the handler runs. */
export function homeIdOf(req: FastifyRequest): string {
  return idParam(req, 'homeId');
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

function setSessionCookie(reply: FastifyReply, token: string, secure: boolean): void {
  reply.header('set-cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`);
}

function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  reply.header('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`);
}

function sameOrigin(req: FastifyRequest, publicOrigin: string | undefined): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients; browsers always send Origin on cross-site POSTs
  if (publicOrigin) return origin === publicOrigin;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** Platform-scope check usable by feature modules (e.g. for list filtering). */
export function requireScope(req: FastifyRequest, ...allowed: PlatformScope[]): PlatformScope {
  if (!req.scope || !allowed.includes(req.scope)) throw forbidden();
  return req.scope;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: Authenticated;
    scope?: PlatformScope;
  }
  interface FastifyInstance {
    routeGuards: Array<{ method: string; url: string; guard: CloudGuard }>;
  }
  interface FastifyContextConfig {
    guard?: CloudGuard;
  }
}
