import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Auth } from './auth.js';
import { CUSTOMER_COOKIE, SETUP_COOKIE, SESSION_TTL, CustomerAccounts, CustomerError } from './customer-accounts.js';

const email = z.email().max(254).transform(v => v.trim().toLowerCase());
const password = z.string().min(12, 'Use at least 12 characters.').max(256);
const devices = z.union([z.literal('*'), z.array(z.string().regex(/^[a-z0-9_-]{1,64}$/i)).max(500)]);
export const CUSTOMER_PUBLIC_ROUTES = ['GET /api/v1/customer/setup', 'POST /api/v1/customer/claim', 'POST /api/v1/customer/signup', 'POST /api/v1/customer/login', 'POST /api/v1/customer/logout', 'POST /api/v1/customer/forgot', 'POST /api/v1/customer/reset'] as const;
export function readCustomerCookie(raw: string | undefined, name = CUSTOMER_COOKIE): string | undefined {
  return raw?.split(';').map(p => p.trim()).find(p => p.startsWith(`${name}=`))?.slice(name.length + 1);
}
export function customerOriginAllowed(req: FastifyRequest, accounts: CustomerAccounts): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return origin === accounts.options.origin || new URL(origin).host === req.headers.host; } catch { return false; }
}
export function customerRoutes(app: FastifyInstance, accounts: CustomerAccounts, auth: Auth): void {
  const attempts = new Map<string, { at: number; count: number }>();
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    const customerCookie = readCustomerCookie(req.headers.cookie);
    if (customerCookie && !['GET','HEAD','OPTIONS'].includes(req.method) && !customerOriginAllowed(req, accounts)) return reply.status(403).send({ error: 'Cross-origin request refused.' });
    if (!req.url.startsWith('/api/v1/customer/')) return;
    if (!['GET','HEAD'].includes(req.method) && !customerOriginAllowed(req, accounts)) return reply.status(403).send({ error: 'Cross-origin request refused.' });
    if (req.method === 'POST' && ['claim','login','forgot','reset','signup'].some(p => req.routeOptions.url?.endsWith(`/${p}`))) {
      const key = `${req.ip}:${req.routeOptions.url}`;
      const now = Date.now();
      const duration = req.routeOptions.url?.endsWith('/forgot') ? 3600_000 : 60_000;
      let entry = attempts.get(key);
      if (!entry || now - entry.at > duration) { entry = { at: now, count: 0 }; attempts.set(key, entry); }
      if (++entry.count > (duration === 3600_000 ? 6 : 10)) return reply.status(429).send({ error: 'Too many attempts. Please try again later.' });
      if (attempts.size > 10_000) for (const [k,v] of attempts) if (now - v.at > 3600_000) attempts.delete(k);
    }
  });
  const open = { config: { guard: { public: true as const } } };
  const owner = { config: { guard: { action: 'client.manage' as const } } };
  const parse = <T extends z.ZodType>(schema: T, value: unknown): z.infer<T> => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new CustomerError(400, parsed.error.issues[0]?.message ?? 'Invalid request.');
    return parsed.data;
  };
  const cookie = (name: string, value: string, ttl: number) => `${name}=${value}; Path=/; Max-Age=${ttl}; HttpOnly; SameSite=Strict${accounts.options.cookieSecure === false ? '' : '; Secure'}`;
  const setupToken = (req: FastifyRequest) => readCustomerCookie(req.headers.cookie, SETUP_COOKIE);
  app.get('/api/v1/customer/setup', open, async req => {
    const invite = accounts.setup(setupToken(req));
    return { email: invite.email, role: invite.role };
  });
  app.post('/api/v1/customer/claim', open, async (req, reply) => {
    const { code } = parse(z.object({ code: z.string().min(10).max(128) }), req.body);
    const claim = accounts.claim(code);
    reply.header('set-cookie', cookie(SETUP_COOKIE, claim.setupToken, 900));
    return { email: claim.email, role: claim.role };
  });
  app.post('/api/v1/customer/signup', open, async (req, reply) => {
    const body = parse(z.object({ email, name: z.string().trim().min(1).max(64), password }), req.body);
    await accounts.signup(setupToken(req), body.email, body.name, body.password);
    reply.header('set-cookie', cookie(SETUP_COOKIE, '', 0));
    return reply.status(201).send({ ok: true });
  });
  app.post('/api/v1/customer/login', open, async (req, reply) => {
    const body = parse(z.object({ email, password: z.string().min(1).max(256), acceptInvitation: z.boolean().optional() }), req.body);
    const result = await accounts.login(body.email, body.password, body.acceptInvitation ? setupToken(req) : undefined);
    reply.header('set-cookie', [cookie(CUSTOMER_COOKIE, result.sessionToken, SESSION_TTL / 1000), cookie(SETUP_COOKIE, '', 0)]);
    return { clientId: result.client.clientId, role: result.client.role, token: 'cookie', name: result.client.name };
  });
  app.post('/api/v1/customer/logout', open, async (req, reply) => {
    accounts.logout(readCustomerCookie(req.headers.cookie));
    reply.header('set-cookie', [cookie(CUSTOMER_COOKIE, '', 0), cookie(SETUP_COOKIE, '', 0)]);
    return { ok: true };
  });
  app.post('/api/v1/customer/forgot', open, async req => {
    const body = parse(z.object({ email }), req.body);
    await accounts.forgot(body.email);
    return { message: 'If that email has an account, a password reset code has been sent. Check your inbox and spam folder.' };
  });
  app.post('/api/v1/customer/reset', open, async req => {
    const body = parse(z.object({ email, code: z.string().regex(/^\d{6}$/), password }), req.body);
    await accounts.reset(body.email, body.code, body.password);
    return { ok: true };
  });
  app.post('/api/v1/customer/invitations', owner, async (req, reply) => {
    const body = parse(z.object({ email, devices }), req.body);
    const principal = req.client!;
    const scope = auth.get(principal.clientId);
    if (!scope || scope.role !== 'owner') throw new CustomerError(403, 'Only the owner can invite family.');
    return reply.status(201).send(await accounts.invite(scope, body.email, body.devices));
  });
  app.get('/api/v1/customer/invitations', owner, async () => accounts.invitations());
  app.delete<{ Params: { id: string } }>('/api/v1/customer/invitations/:id', owner, async (req, reply) => {
    accounts.revokeInvite(req.params.id);
    return reply.status(204).send();
  });
}
