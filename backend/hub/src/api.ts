import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import {
  automationInputSchema,
  automationUpdateSchema,
  commandRequestSchema,
  homeRoleOf,
  homeScope,
  inviteSchema,
  memberDevicesSchema,
  pairRequestSchema,
  parseEntityId,
  pushSubscriptionSchema,
  pushUnsubscribeSchema,
  renameSchema,
  roleChangeSchema,
  roomSchema,
  scheduleInputSchema,
  scheduleUpdateSchema,
  updatePolicyBodySchema,
  wsClientMessageSchema,
  type ClientView,
  type HealthView,
  type HomeAction,
  type HubEvent,
  type WsServerMessage,
} from '@voltax/contracts';
import type { z } from 'zod';
import type { AuditLog } from './audit.js';
import type { Auth, Client, DeviceScope } from './auth.js';
import type { AutomationEngine } from './automations.js';
import type { CommandManager } from './commands.js';
import type { EventLog } from './events.js';
import type { SupportGrants } from './grants.js';
import type { HubPush } from './push.js';
import { InvalidScheduleError, type Scheduler } from './scheduler.js';
import { InvalidAutomationError } from './automations.js';
import type { Store } from './store.js';
import type { UpdateService } from './updates.js';

export interface ApiDeps {
  hubId: string;
  hubName: string;
  version: string;
  store: Store;
  events: EventLog;
  commands: CommandManager;
  auth: Auth;
  audit: AuditLog;
  grants: SupportGrants;
  updates: UpdateService;
  push: HubPush;
  scheduler: Scheduler;
  automations: AutomationEngine;
  health: () => HealthView;
  uiDir?: string;
}

/** Every /api route declares exactly one of these; a route without one makes startup fail. */
export type RouteGuard = { public: true } | { action: HomeAction; ws?: true };

/** The only routes reachable without a client token. */
export const PUBLIC_API_ROUTES = ['GET /api/v1/health', 'GET /api/v1/hub/identity', 'POST /api/v1/pair'] as const;

const WS_AUTH_TIMEOUT_MS = 5000;
const UNAUTH_AUDIT_INTERVAL_MS = 60_000;

/** Deny-by-default: refuses to register an /api route that does not declare its permission. */
export function assertGuarded(method: string, url: string, guard: RouteGuard | undefined): void {
  if (!url.startsWith('/api/') || method === 'HEAD') return;
  if (!guard) throw new Error(`route ${method} ${url} has no permission guard`);
  if ('public' in guard && !(PUBLIC_API_ROUTES as readonly string[]).includes(`${method} ${url}`)) {
    throw new Error(`route ${method} ${url} is not on the public allow-list`);
  }
}

export async function buildApi(deps: ApiDeps, serverOptions: FastifyServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ ...serverOptions, trustProxy: false });
  const guards: Array<{ method: string; url: string; guard: RouteGuard }> = [];
  app.decorate('routeGuards', guards);

  app.addHook('onRoute', (route) => {
    const guard = (route.config as { guard?: RouteGuard } | undefined)?.guard;
    for (const method of [route.method].flat()) {
      assertGuarded(method, route.url, guard);
      if (guard && route.url.startsWith('/api/') && method !== 'HEAD') guards.push({ method, url: route.url, guard });
    }
  });

  await app.register(fastifyWebsocket);

  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
    return payload;
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) req.log.error({ err }, 'request failed');
    void reply.status(status).send({ error: status === 500 ? 'internal error' : err.message });
  });

  // Unauthenticated attempts are audited at most once per minute per address and route, so a
  // scanner cannot flood the audit log.
  const lastUnauthAudit = new Map<string, number>();
  const auditUnauthenticated = (req: FastifyRequest) => {
    const key = `${req.ip} ${req.routeOptions.url ?? req.url}`;
    const now = Date.now();
    if (now - (lastUnauthAudit.get(key) ?? 0) < UNAUTH_AUDIT_INTERVAL_MS) return;
    lastUnauthAudit.set(key, now);
    if (lastUnauthAudit.size > 10_000) lastUnauthAudit.clear();
    deps.audit.append({ actor: `ip:${req.ip}`, action: 'auth.failed', outcome: 'denied', target: `${req.method} ${req.routeOptions.url ?? req.url}` });
  };

  // One authorization point for every /api route: authenticate, then check the permission matrix.
  app.addHook('preHandler', async (req, reply) => {
    const guard = (req.routeOptions.config as { guard?: RouteGuard } | undefined)?.guard;
    if (!req.url.startsWith('/api/') || !req.routeOptions.url) return; // static files, or a 404
    if (!guard) return reply.status(403).send({ error: 'forbidden' }); // unreachable: onRoute refuses unguarded routes
    if ('public' in guard || guard.ws) return; // the WebSocket authenticates in its first message
    const header = req.headers.authorization;
    const client = deps.auth.authenticate(header?.startsWith('Bearer ') ? header.slice(7) : undefined);
    if (!client) {
      auditUnauthenticated(req);
      return reply.status(401).send({ error: 'unauthorized' });
    }
    if (!homeScope(homeRoleOf(client.role), guard.action)) {
      deps.audit.append({ actor: `client:${client.clientId}`, action: guard.action, outcome: 'denied', target: `${req.method} ${req.routeOptions.url}`, details: { reason: 'role' } });
      return reply.status(403).send({ error: 'not allowed for your role' });
    }
    req.client = client;
    req.deviceScope = deps.auth.deviceScope(client);
  });

  const can = (action: HomeAction) => ({ config: { guard: { action } satisfies RouteGuard } });
  const open = { config: { guard: { public: true } satisfies RouteGuard } };
  const actor = (req: FastifyRequest) => `client:${req.client!.clientId}`;
  const inScope = (req: FastifyRequest, deviceId: string) => allows(req.deviceScope!, deviceId);
  const entityInScope = (req: FastifyRequest, entityId: string) => {
    const ref = parseEntityId(entityId);
    return !!ref && inScope(req, ref.deviceId);
  };
  /** Out-of-scope resources look exactly like missing ones, so members cannot enumerate devices. */
  const deniedAsMissing = (req: FastifyRequest, reply: FastifyReply, action: HomeAction, target: string, error: string) => {
    deps.audit.append({ actor: actor(req), action, outcome: 'denied', target, details: { reason: 'device not granted' } });
    return reply.status(404).send({ error });
  };

  // --- public ---
  app.get('/api/v1/health', open, async () => deps.health());
  app.get('/api/v1/hub/identity', open, async () => ({ hubId: deps.hubId, name: deps.hubName, version: deps.version }));

  app.post('/api/v1/pair', open, async (req, reply) => {
    const body = parse(pairRequestSchema, req.body, reply);
    if (!body) return;
    const result = deps.auth.pair(body.pairingCode, body.clientName, req.ip);
    if (!result.ok) {
      deps.audit.append({ actor: `ip:${req.ip}`, action: 'client.pair', outcome: 'denied', details: { status: result.status } });
      return reply.status(result.status).send({ error: result.error });
    }
    deps.audit.append({ actor: `client:${result.clientId}`, action: 'client.pair', outcome: 'ok', target: result.clientId, details: { role: result.role } });
    req.log.info({ clientId: result.clientId, role: result.role }, 'client paired'); // never log code or token
    return reply.status(201).send({ clientId: result.clientId, token: result.token, role: result.role });
  });

  // --- this client: its current role and devices (a role change applies without pairing again) ---
  app.get('/api/v1/me', can('events.read'), async (req) => {
    const c = req.client!;
    return { clientId: c.clientId, name: c.name, role: c.role, devices: c.role === 'member' ? deps.auth.memberDevices(c.clientId) : '*', push: deps.push.count(c.clientId) };
  });

  // --- browser notifications (opt-in per phone/browser) ---
  app.get('/api/v1/push/key', can('events.read'), async (_req, reply) =>
    deps.push.publicKey ? { publicKey: deps.push.publicKey } : reply.status(404).send({ error: 'notifications are not available on this hub' }),
  );
  app.post('/api/v1/push/subscriptions', can('events.read'), async (req, reply) => {
    const body = parse(pushSubscriptionSchema, req.body, reply);
    if (!body) return;
    if (deps.push.subscribe(req.client!.clientId, body) === 'bad_host') return reply.status(400).send({ error: 'not a supported browser push service' });
    deps.audit.append({ actor: actor(req), action: 'push.subscribe', outcome: 'ok', details: { host: new URL(body.endpoint).hostname } });
    return reply.status(204).send();
  });
  app.delete('/api/v1/push/subscriptions', can('events.read'), async (req, reply) => {
    const body = parse(pushUnsubscribeSchema, req.body, reply);
    if (!body) return;
    deps.push.unsubscribe(req.client!.clientId, body.endpoint);
    return reply.status(204).send();
  });

  // --- clients & pairing (owner) ---
  app.post('/api/v1/pairing-codes', can('client.manage'), async (req, reply) => {
    const body = parse(inviteSchema, req.body, reply);
    if (!body) return;
    const created = deps.auth.createPairingCode('member', undefined, body.devices);
    deps.audit.append({ actor: actor(req), action: 'client.invite', outcome: 'ok', details: { role: 'member', devices: body.devices } });
    return reply.status(201).send(created);
  });
  app.get('/api/v1/clients', can('client.manage'), async (): Promise<ClientView[]> =>
    deps.auth.listClients().map((c) => (c.role === 'member' ? { ...c, devices: deps.auth.memberDevices(c.clientId) } : c)),
  );
  app.put<{ Params: { id: string } }>('/api/v1/clients/:id/devices', can('client.manage'), async (req, reply) => {
    const body = parse(memberDevicesSchema, req.body, reply);
    if (!body) return;
    const r = deps.auth.setMemberDevices(req.params.id, body.devices);
    if (r === 'not_found') return reply.status(404).send({ error: 'client not found' });
    if (r === 'not_member') return reply.status(409).send({ error: 'owners always have every device' });
    deps.audit.append({ actor: actor(req), action: 'client.devices', outcome: 'ok', target: req.params.id, details: { devices: body.devices } });
    return reply.status(204).send();
  });
  app.put<{ Params: { id: string } }>('/api/v1/clients/:id/role', can('client.manage'), async (req, reply) => {
    const body = parse(roleChangeSchema, req.body, reply);
    if (!body) return;
    const r = deps.auth.setRole(req.params.id, body.role, body.devices);
    if (r === 'not_found') return reply.status(404).send({ error: 'client not found' });
    if (r === 'last_owner') return reply.status(409).send({ error: 'the home must keep at least one owner' });
    deps.audit.append({ actor: actor(req), action: 'client.role', outcome: 'ok', target: req.params.id, details: { role: body.role, devices: body.role === 'member' ? (body.devices ?? '*') : null } });
    return reply.status(204).send();
  });
  app.delete<{ Params: { id: string } }>('/api/v1/clients/:id', can('client.manage'), async (req, reply) => {
    const r = deps.auth.revoke(req.params.id);
    if (r === 'not_found') return reply.status(404).send({ error: 'client not found' });
    if (r === 'last_owner') return reply.status(409).send({ error: 'cannot revoke the last owner' });
    deps.audit.append({ actor: actor(req), action: 'client.revoke', outcome: 'ok', target: req.params.id });
    return reply.status(204).send();
  });

  // --- devices & commands ---
  app.get('/api/v1/devices', can('device.read'), async (req) => deps.store.listDevices().filter((d) => inScope(req, d.deviceId)));
  app.delete<{ Params: { id: string } }>('/api/v1/devices/:id', can('device.manage'), async (req, reply) => {
    if (!deps.store.deleteDevice(req.params.id)) return reply.status(404).send({ error: 'device not found' });
    deps.audit.append({ actor: actor(req), action: 'device.remove', outcome: 'ok', target: req.params.id });
    return reply.status(204).send();
  });

  app.patch<{ Params: { id: string } }>('/api/v1/devices/:id', can('device.manage'), async (req, reply) => {
    const body = parse(renameSchema, req.body, reply);
    if (!body) return;
    return deps.store.renameDevice(req.params.id, body.name) ? reply.status(204).send() : reply.status(404).send({ error: 'device not found' });
  });
  app.put<{ Params: { id: string } }>('/api/v1/devices/:id/room', can('device.manage'), async (req, reply) => {
    const body = parse(roomSchema, req.body, reply);
    if (!body) return;
    return deps.store.setRoom(req.params.id, body.room) ? reply.status(204).send() : reply.status(404).send({ error: 'device not found' });
  });
  app.patch<{ Params: { id: string } }>('/api/v1/entities/:id', can('device.manage'), async (req, reply) => {
    const body = parse(renameSchema, req.body, reply);
    if (!body) return;
    return deps.store.renameEntity(req.params.id, body.name) ? reply.status(204).send() : reply.status(404).send({ error: 'entity not found' });
  });

  app.post<{ Params: { id: string } }>('/api/v1/entities/:id/commands', can('device.command'), async (req, reply) => {
    const body = parse(commandRequestSchema, req.body, reply);
    if (!body) return;
    if (!entityInScope(req, req.params.id)) return deniedAsMissing(req, reply, 'device.command', req.params.id, 'unknown entity');
    const result = deps.commands.submit({ ...body, entityId: req.params.id, source: 'local' });
    if ('error' in result) return reply.status(result.status).send({ error: result.error });
    return reply.status(result.status).send(result.command);
  });

  app.get<{ Params: { id: string } }>('/api/v1/commands/:id', can('device.read'), async (req, reply) => {
    const cmd = deps.commands.get(req.params.id);
    if (cmd && !entityInScope(req, cmd.entityId)) return deniedAsMissing(req, reply, 'device.read', req.params.id, 'command not found');
    return cmd ?? reply.status(404).send({ error: 'command not found' });
  });

  app.get<{ Querystring: { afterSeq?: string; limit?: string } }>('/api/v1/events', can('events.read'), async (req) => {
    const afterSeq = Math.max(0, Number(req.query.afterSeq ?? 0) || 0);
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit ?? 500) || 500));
    return deps.events.since(afterSeq, limit).filter((e) => eventVisible(req.deviceScope!, e));
  });

  // --- schedules (owner manages; members see rules on their devices) ---
  app.get('/api/v1/schedules', can('schedule.read'), async (req) => deps.scheduler.list().filter((s) => entityInScope(req, s.entityId)));
  app.post('/api/v1/schedules', can('schedule.manage'), async (req, reply) => {
    const body = parse(scheduleInputSchema, req.body, reply);
    if (!body) return;
    return scheduleErrors(reply, () => reply.status(201).send(deps.scheduler.create(body)));
  });
  app.put<{ Params: { id: string } }>('/api/v1/schedules/:id', can('schedule.manage'), async (req, reply) => {
    const body = parse(scheduleUpdateSchema, req.body, reply);
    if (!body) return;
    return scheduleErrors(reply, () => {
      const { version, ...input } = body;
      const s = deps.scheduler.update(req.params.id, input, version);
      if (s === 'conflict') return reply.status(409).send({ error: 'this schedule was changed by someone else; reload and try again' });
      return s ?? reply.status(404).send({ error: 'schedule not found' });
    });
  });
  app.delete<{ Params: { id: string } }>('/api/v1/schedules/:id', can('schedule.manage'), async (req, reply) =>
    deps.scheduler.delete(req.params.id) ? reply.status(204).send() : reply.status(404).send({ error: 'schedule not found' }),
  );

  // --- automations (owner manages; members see rules on their devices) ---
  app.get('/api/v1/automations', can('automation.read'), async (req) =>
    deps.automations.list().filter((a) => entityInScope(req, a.trigger.entityId) && entityInScope(req, a.action.entityId)),
  );
  app.post('/api/v1/automations', can('automation.manage'), async (req, reply) => {
    const body = parse(automationInputSchema, req.body, reply);
    if (!body) return;
    return scheduleErrors(reply, () => reply.status(201).send(deps.automations.create(body)));
  });
  app.put<{ Params: { id: string } }>('/api/v1/automations/:id', can('automation.manage'), async (req, reply) => {
    const body = parse(automationUpdateSchema, req.body, reply);
    if (!body) return;
    return scheduleErrors(reply, () => {
      const { version, ...input } = body;
      const a = deps.automations.update(req.params.id, input, version);
      if (a === 'conflict') return reply.status(409).send({ error: 'this automation was changed by someone else; reload and try again' });
      return a ?? reply.status(404).send({ error: 'automation not found' });
    });
  });
  app.delete<{ Params: { id: string } }>('/api/v1/automations/:id', can('automation.manage'), async (req, reply) =>
    deps.automations.delete(req.params.id) ? reply.status(204).send() : reply.status(404).send({ error: 'automation not found' }),
  );

  // --- support access (owner approves on the hub; members can see that a session exists) ---
  app.get('/api/v1/support/grants', can('grant.read'), async () => deps.grants.list());
  app.post<{ Params: { id: string } }>('/api/v1/support/grants/:id/approve', can('grant.approve'), async (req, reply) => {
    const r = deps.grants.approve(req.params.id, req.client!.clientId);
    if (r === 'not_found') return reply.status(404).send({ error: 'support request not found' });
    if (r === 'not_pending') return reply.status(409).send({ error: 'this request was already decided' });
    if (r === 'over') return reply.status(409).send({ error: 'this request has expired' });
    return deps.grants.get(req.params.id);
  });
  app.post<{ Params: { id: string } }>('/api/v1/support/grants/:id/reject', can('grant.approve'), async (req, reply) => {
    const r = deps.grants.reject(req.params.id, req.client!.clientId);
    if (r === 'not_found') return reply.status(404).send({ error: 'support request not found' });
    if (r === 'not_pending') return reply.status(409).send({ error: 'this request was already decided' });
    return deps.grants.get(req.params.id);
  });
  app.post<{ Params: { id: string } }>('/api/v1/support/grants/:id/revoke', can('grant.approve'), async (req, reply) => {
    const r = deps.grants.revoke(req.params.id, req.client!.clientId);
    if (r === 'not_found') return reply.status(404).send({ error: 'support request not found' });
    if (r === 'already_ended') return reply.status(409).send({ error: 'this support session has already ended' });
    return deps.grants.get(req.params.id);
  });

  // --- fleet updates (owner): policy and decisions on offers from VOLTEX ---
  app.get('/api/v1/updates', can('update.manage'), async () => deps.updates.view());
  app.put('/api/v1/updates/policy', can('update.manage'), async (req, reply) => {
    const body = parse(updatePolicyBodySchema, req.body, reply);
    if (!body) return reply;
    deps.updates.setPolicy(body.policy, actor(req));
    return deps.updates.view();
  });
  for (const decision of ['approve', 'decline'] as const) {
    app.post<{ Params: { rolloutId: string } }>(`/api/v1/updates/:rolloutId/${decision}`, can('update.manage'), async (req, reply) => {
      const r = deps.updates[decision](req.params.rolloutId, req.client!.clientId);
      if (r === 'not_found') return reply.status(404).send({ error: 'update offer not found' });
      if (r === 'already_decided') return reply.status(409).send({ error: 'this offer was already decided or withdrawn' });
      if (r === 'busy') return reply.status(409).send({ error: 'another update is in progress' });
      return deps.updates.view();
    });
  }

  // --- audit (owner) ---
  app.get<{ Querystring: { afterSeq?: string } }>('/api/v1/audit', can('audit.read'), async (req) => ({
    records: deps.audit.since(Math.max(0, Number(req.query.afterSeq ?? 0) || 0)),
    verify: deps.audit.verify(),
  }));

  // --- live events: first message must be {type:'auth', token, resumeAfterSeq?} ---
  app.get('/api/v1/ws', { websocket: true, config: { guard: { action: 'events.read', ws: true } satisfies RouteGuard } }, (socket, req) => {
    const send = (msg: WsServerMessage) => socket.send(JSON.stringify(msg));
    let cleanup: Array<() => void> = [];
    const authTimer = setTimeout(() => socket.close(4401, 'auth timeout'), WS_AUTH_TIMEOUT_MS);

    socket.once('message', (raw: Buffer) => {
      clearTimeout(authTimer);
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        msg = null;
      }
      const parsed = wsClientMessageSchema.safeParse(msg);
      const client = parsed.success ? deps.auth.authenticate(parsed.data.token) : null;
      if (!parsed.success || !client || !homeScope(homeRoleOf(client.role), 'events.read')) {
        auditUnauthenticated(req);
        send({ type: 'error', error: 'unauthorized' });
        socket.close(4401, 'unauthorized');
        return;
      }
      // The scope is re-read for every event, so a change to a member's devices applies at once.
      const visible = (event: HubEvent) => {
        const current = deps.auth.get(client.clientId); // role and devices as they are now
        return current !== null && eventVisible(deps.auth.deviceScope(current), event);
      };
      // Replay then subscribe in the same tick: SQLite calls are synchronous, so no event can slip between.
      let lastSent = parsed.data.resumeAfterSeq ?? deps.events.lastSeq();
      for (const event of deps.events.since(lastSent)) {
        if (visible(event)) send({ type: 'event', event });
        lastSent = event.seq;
      }
      send({ type: 'ready', lastSeq: lastSent });
      cleanup = [
        deps.events.subscribe((event) => {
          if (event.seq > lastSent) {
            lastSent = event.seq;
            if (visible(event)) send({ type: 'event', event });
          }
        }),
        deps.auth.onRevoke((id) => {
          if (id === client.clientId) socket.close(4403, 'revoked');
        }),
      ];
    });
    socket.on('close', () => {
      clearTimeout(authTimer);
      for (const fn of cleanup) fn();
    });
  });

  // Web app: the static Next.js export of frontend/web (one index.html per route, e.g. /schedules/).
  // redirect: /schedules -> /schedules/ so typed or bookmarked URLs without the slash still work.
  if (deps.uiDir && existsSync(deps.uiDir)) {
    await app.register(fastifyStatic, { root: deps.uiDir, prefix: '/', redirect: true });
  }

  return app;
}

function allows(scope: DeviceScope, deviceId: string): boolean {
  return scope === 'all' || scope.has(deviceId);
}

/** Events about a device are only shown to clients that may see that device; hub-wide events to all. */
export function eventVisible(scope: DeviceScope, event: HubEvent): boolean {
  if (scope === 'all') return true;
  const p = event.payload;
  const deviceId = typeof p.deviceId === 'string' ? p.deviceId : typeof p.entityId === 'string' ? parseEntityId(p.entityId)?.deviceId : undefined;
  if (deviceId !== undefined) return scope.has(deviceId);
  return typeof p.entityId !== 'string'; // an unparseable entity id is hidden, not shown
}

function parse<T extends z.ZodType>(schema: T, body: unknown, reply: FastifyReply): z.infer<T> | null {
  const r = schema.safeParse(body);
  if (r.success) return r.data;
  void reply.status(400).send({ error: 'invalid request', issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  return null;
}

function scheduleErrors<T>(reply: FastifyReply, fn: () => T): T | FastifyReply {
  try {
    return fn();
  } catch (err) {
    if (err instanceof InvalidScheduleError || err instanceof InvalidAutomationError) return reply.status(400).send({ error: err.message });
    throw err;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    client?: Client;
    deviceScope?: DeviceScope;
  }
  interface FastifyInstance {
    routeGuards: Array<{ method: string; url: string; guard: RouteGuard }>;
  }
}
