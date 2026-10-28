import type { FastifyInstance } from 'fastify';
import {
  activityRequestSchema,
  grantCommandSchema,
  grantCreateSchema,
  grantRevokeSchema,
  grantStatusSchema,
  pushSubscriptionSchema,
} from '@voltax/contracts';
import { z } from 'zod';
import { homeIdOf, parse, staffIdOf } from './api.js';
import type { StaffPush } from './channels.js';
import type { AuditCheckpoints } from './checkpoints.js';
import { notFound } from './errors.js';
import { actorOf, type GrantService } from './grants.js';
import type { HubAuditStore } from './hub-audit.js';
import type { HomesService } from './homes.js';
import type { Notifications } from './notifications.js';

export interface SupportRouteDeps {
  grants: GrantService;
  notifications: Notifications;
  homes: HomesService;
  hubAudit: HubAuditStore;
  checkpoints: AuditCheckpoints;
  push: StaffPush;
}

const grantIdOf = (params: unknown): string => {
  const id = (params as { grantId?: string }).grantId;
  if (!id || !z.uuid().safeParse(id).success) throw notFound();
  return id;
};

export function supportRoutes(deps: SupportRouteDeps) {
  return (app: FastifyInstance) => {
    const { grants, notifications, homes, hubAudit, checkpoints, push } = deps;
    const actor = (req: { auth?: { staff: Parameters<typeof actorOf>[0] } }) => actorOf(req.auth!.staff);
    const base = '/api/v1/homes/:homeId/grants';

    app.get('/api/v1/grants', { config: { guard: { action: 'grant.read', list: true } } }, async (req) => {
      const q = parse(z.object({ status: grantStatusSchema.optional() }), req.query);
      return grants.list(staffIdOf(req), req.scope === 'platform' ? 'platform' : 'assigned', q);
    });

    app.post(base, { config: { guard: { action: 'grant.request', home: 'params' } } }, async (req, reply) => {
      const body = parse(grantCreateSchema, req.body);
      return reply.status(201).send(await grants.request(actor(req), homeIdOf(req), body));
    });

    app.get(base, { config: { guard: { action: 'grant.read', home: 'params' } } }, async (req) => grants.listForHome(homeIdOf(req)));

    app.get(`${base}/:grantId`, { config: { guard: { action: 'grant.read', home: 'params' } } }, async (req) => grants.get(homeIdOf(req), grantIdOf(req.params)));

    app.get(`${base}/:grantId/notifications`, { config: { guard: { action: 'notification.read', home: 'params' } } }, async (req) => {
      await grants.get(homeIdOf(req), grantIdOf(req.params));
      return notifications.list(grantIdOf(req.params));
    });

    app.post(`${base}/:grantId/revoke`, { config: { guard: { action: 'grant.revoke', home: 'params', own: true } } }, async (req) => {
      const body = parse(grantRevokeSchema, req.body);
      return grants.revoke(actor(req), homeIdOf(req), grantIdOf(req.params), body.reason, body.outcome);
    });

    app.post(`${base}/:grantId/commands`, { config: { guard: { action: 'device.command', home: 'params' } } }, async (req, reply) => {
      const body = parse(grantCommandSchema, req.body);
      return reply.status(202).send(await grants.command(actor(req), homeIdOf(req), grantIdOf(req.params), body.entityId, body.value));
    });

    app.get(`${base}/:grantId/commands`, { config: { guard: { action: 'grant.read', home: 'params' } } }, async (req) => grants.commands(homeIdOf(req), grantIdOf(req.params)));

    app.post(`${base}/:grantId/diagnostics`, { config: { guard: { action: 'diagnostics.read', home: 'params' } } }, async (req) =>
      grants.diagnostics(actor(req), homeIdOf(req), grantIdOf(req.params)),
    );

    app.post(`${base}/:grantId/activity`, { config: { guard: { action: 'activity.read', home: 'params' } } }, async (req) => {
      const body = parse(activityRequestSchema, req.body);
      return grants.activity(actor(req), homeIdOf(req), grantIdOf(req.params), body.sinceMinutes * 60_000);
    });

    app.post(`${base}/:grantId/restart`, { config: { guard: { action: 'hub.restart', home: 'params' } } }, async (req, reply) => {
      await grants.restart(actor(req), homeIdOf(req), grantIdOf(req.params));
      return reply.status(202).send({ ok: true });
    });

    // --- audit: hub copies and checkpoints (super admin) -------------------------------------------

    app.get('/api/v1/homes/:homeId/hub/audit', { config: { guard: { action: 'audit.read', home: 'params' } } }, async (req) => {
      const hubId = await homes.hubOf(homeIdOf(req));
      if (!hubId) throw notFound();
      const q = parse(z.object({ afterSeq: z.coerce.number().int().min(0).optional() }), req.query);
      return { summary: await hubAudit.summary(hubId), records: await hubAudit.list(hubId, q.afterSeq ?? 0) };
    });

    app.get('/api/v1/audit/checkpoints', { config: { guard: { action: 'audit.verify' } } }, async () => checkpoints.list());

    // --- staff Web Push (own browser subscriptions) -----------------------------------------------

    app.get('/api/v1/push', { config: { guard: { session: 'self' } } }, async (req) => ({
      enabled: push.enabled,
      publicKey: push.publicKey,
      subscriptions: await push.count(staffIdOf(req)),
    }));

    app.post('/api/v1/push/subscriptions', { config: { guard: { session: 'self' } } }, async (req, reply) => {
      await push.subscribe(staffIdOf(req), parse(pushSubscriptionSchema, req.body));
      return reply.status(201).send({ ok: true });
    });

    app.post('/api/v1/push/unsubscribe', { config: { guard: { session: 'self' } } }, async (req) => {
      const body = parse(z.object({ endpoint: z.string().max(1000) }), req.body);
      await push.unsubscribe(staffIdOf(req), body.endpoint);
      return { ok: true };
    });
  };
}
