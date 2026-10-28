import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import {
  automationInputSchema,
  commandRequestSchema,
  pairRequestSchema,
  renameSchema,
  scheduleInputSchema,
  wsClientMessageSchema,
  type HealthView,
  type Role,
  type WsServerMessage,
} from '@voltax/contracts';
import type { z } from 'zod';
import type { Auth, Client } from './auth.js';
import type { AutomationEngine } from './automations.js';
import type { CommandManager } from './commands.js';
import type { EventLog } from './events.js';
import { InvalidScheduleError, type Scheduler } from './scheduler.js';
import type { Store } from './store.js';

export interface ApiDeps {
  hubId: string;
  hubName: string;
  version: string;
  store: Store;
  events: EventLog;
  commands: CommandManager;
  auth: Auth;
  scheduler: Scheduler;
  automations: AutomationEngine;
  health: () => HealthView;
  uiDir?: string;
}

const WS_AUTH_TIMEOUT_MS = 5000;

export async function buildApi(deps: ApiDeps, serverOptions: FastifyServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ ...serverOptions, trustProxy: false });
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

  const requireClient = (role?: Role) => async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const client = deps.auth.authenticate(token);
    if (!client) return reply.status(401).send({ error: 'unauthorized' });
    if (role === 'owner' && client.role !== 'owner') return reply.status(403).send({ error: 'owner only' });
    req.client = client;
  };
  const anyClient = { preHandler: requireClient() };
  const ownerOnly = { preHandler: requireClient('owner') };

  // --- public ---
  app.get('/api/v1/health', async () => deps.health());
  app.get('/api/v1/hub/identity', async () => ({ hubId: deps.hubId, name: deps.hubName, version: deps.version }));

  app.post('/api/v1/pair', async (req, reply) => {
    const body = parse(pairRequestSchema, req.body, reply);
    if (!body) return;
    const result = deps.auth.pair(body.pairingCode, body.clientName, req.ip);
    if (!result.ok) return reply.status(result.status).send({ error: result.error });
    req.log.info({ clientId: result.clientId, role: result.role }, 'client paired'); // never log code or token
    return reply.status(201).send({ clientId: result.clientId, token: result.token, role: result.role });
  });

  // --- clients & pairing (owner) ---
  app.post('/api/v1/pairing-codes', ownerOnly, async (_req, reply) => reply.status(201).send(deps.auth.createPairingCode('member')));
  app.get('/api/v1/clients', ownerOnly, async () => deps.auth.listClients());
  app.delete<{ Params: { id: string } }>('/api/v1/clients/:id', ownerOnly, async (req, reply) => {
    const r = deps.auth.revoke(req.params.id);
    if (r === 'not_found') return reply.status(404).send({ error: 'client not found' });
    if (r === 'last_owner') return reply.status(409).send({ error: 'cannot revoke the last owner' });
    return reply.status(204).send();
  });

  // --- devices & commands ---
  app.get('/api/v1/devices', anyClient, async () => deps.store.listDevices());
  app.delete<{ Params: { id: string } }>('/api/v1/devices/:id', ownerOnly, async (req, reply) =>
    deps.store.deleteDevice(req.params.id) ? reply.status(204).send() : reply.status(404).send({ error: 'device not found' }),
  );

  app.patch<{ Params: { id: string } }>('/api/v1/devices/:id', ownerOnly, async (req, reply) => {
    const body = parse(renameSchema, req.body, reply);
    if (!body) return;
    return deps.store.renameDevice(req.params.id, body.name) ? reply.status(204).send() : reply.status(404).send({ error: 'device not found' });
  });
  app.patch<{ Params: { id: string } }>('/api/v1/entities/:id', ownerOnly, async (req, reply) => {
    const body = parse(renameSchema, req.body, reply);
    if (!body) return;
    return deps.store.renameEntity(req.params.id, body.name) ? reply.status(204).send() : reply.status(404).send({ error: 'entity not found' });
  });

  app.post<{ Params: { id: string } }>('/api/v1/entities/:id/commands', anyClient, async (req, reply) => {
    const body = parse(commandRequestSchema, req.body, reply);
    if (!body) return;
    const result = deps.commands.submit({ ...body, entityId: req.params.id, source: 'local' });
    if ('error' in result) return reply.status(result.status).send({ error: result.error });
    return reply.status(result.status).send(result.command);
  });

  app.get<{ Params: { id: string } }>('/api/v1/commands/:id', anyClient, async (req, reply) => {
    const cmd = deps.commands.get(req.params.id);
    return cmd ?? reply.status(404).send({ error: 'command not found' });
  });

  app.get<{ Querystring: { afterSeq?: string; limit?: string } }>('/api/v1/events', anyClient, async (req) => {
    const afterSeq = Math.max(0, Number(req.query.afterSeq ?? 0) || 0);
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit ?? 500) || 500));
    return deps.events.since(afterSeq, limit);
  });

  // --- schedules (owner) ---
  app.get('/api/v1/schedules', anyClient, async () => deps.scheduler.list());
  app.post('/api/v1/schedules', ownerOnly, async (req, reply) => {
    const body = parse(scheduleInputSchema, req.body, reply);
    if (!body) return;
    return scheduleErrors(reply, () => reply.status(201).send(deps.scheduler.create(body)));
  });
  app.put<{ Params: { id: string } }>('/api/v1/schedules/:id', ownerOnly, async (req, reply) => {
    const body = parse(scheduleInputSchema, req.body, reply);
    if (!body) return;
    return scheduleErrors(reply, () => {
      const s = deps.scheduler.update(req.params.id, body);
      return s ?? reply.status(404).send({ error: 'schedule not found' });
    });
  });
  app.delete<{ Params: { id: string } }>('/api/v1/schedules/:id', ownerOnly, async (req, reply) =>
    deps.scheduler.delete(req.params.id) ? reply.status(204).send() : reply.status(404).send({ error: 'schedule not found' }),
  );

  // --- automations (owner) ---
  app.get('/api/v1/automations', anyClient, async () => deps.automations.list());
  app.post('/api/v1/automations', ownerOnly, async (req, reply) => {
    const body = parse(automationInputSchema, req.body, reply);
    if (!body) return;
    return reply.status(201).send(deps.automations.create(body));
  });
  app.put<{ Params: { id: string } }>('/api/v1/automations/:id', ownerOnly, async (req, reply) => {
    const body = parse(automationInputSchema, req.body, reply);
    if (!body) return;
    return deps.automations.update(req.params.id, body) ?? reply.status(404).send({ error: 'automation not found' });
  });
  app.delete<{ Params: { id: string } }>('/api/v1/automations/:id', ownerOnly, async (req, reply) =>
    deps.automations.delete(req.params.id) ? reply.status(204).send() : reply.status(404).send({ error: 'automation not found' }),
  );

  // --- live events: first message must be {type:'auth', token, resumeAfterSeq?} ---
  app.get('/api/v1/ws', { websocket: true }, (socket) => {
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
      if (!parsed.success || !client) {
        send({ type: 'error', error: 'unauthorized' });
        socket.close(4401, 'unauthorized');
        return;
      }
      // Replay then subscribe in the same tick: SQLite calls are synchronous, so no event can slip between.
      let lastSent = parsed.data.resumeAfterSeq ?? deps.events.lastSeq();
      for (const event of deps.events.since(lastSent)) {
        send({ type: 'event', event });
        lastSent = event.seq;
      }
      send({ type: 'ready', lastSeq: lastSent });
      cleanup = [
        deps.events.subscribe((event) => {
          if (event.seq > lastSent) {
            lastSent = event.seq;
            send({ type: 'event', event });
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
    if (err instanceof InvalidScheduleError) return reply.status(400).send({ error: err.message });
    throw err;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    client?: Client;
  }
}
