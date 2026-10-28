import type { FastifyInstance, FastifyRequest } from 'fastify';
import { releaseCreateSchema, rolloutActionSchema, rolloutCreateSchema } from '@voltax/contracts';
import { z } from 'zod';
import { parse, staffIdOf } from './api.js';
import { notFound } from './errors.js';
import type { FleetService } from './fleet.js';

const idOf = (req: FastifyRequest, key: 'releaseId' | 'rolloutId'): string => {
  const id = (req.params as Record<string, string | undefined>)[key];
  if (!id || !z.uuid().safeParse(id).success) throw notFound();
  return id;
};

/** Release registry and rollouts: platform scope only (super admin manages, support reads). */
export function fleetRoutes(fleet: FleetService) {
  return (app: FastifyInstance) => {
    app.get('/api/v1/fleet/summary', { config: { guard: { action: 'rollout.read' } } }, async () => fleet.summary());

    app.get('/api/v1/releases', { config: { guard: { action: 'firmware.read' } } }, async () => fleet.listReleases());

    app.post('/api/v1/releases', { config: { guard: { action: 'firmware.manage' } } }, async (req, reply) =>
      reply.status(201).send(await fleet.registerRelease(parse(releaseCreateSchema, req.body), staffIdOf(req))),
    );

    app.get('/api/v1/releases/:releaseId', { config: { guard: { action: 'firmware.read' } } }, async (req) => {
      const r = await fleet.release(idOf(req, 'releaseId'));
      if (!r) throw notFound();
      return r;
    });

    app.get('/api/v1/releases/:releaseId/compatibility', { config: { guard: { action: 'rollout.read' } } }, async (req) =>
      fleet.compatibility(idOf(req, 'releaseId')),
    );

    app.post('/api/v1/releases/:releaseId/withdraw', { config: { guard: { action: 'firmware.manage' } } }, async (req) =>
      fleet.withdrawRelease(idOf(req, 'releaseId'), parse(rolloutActionSchema, req.body).reason, staffIdOf(req)),
    );

    app.get('/api/v1/rollouts', { config: { guard: { action: 'rollout.read' } } }, async () => fleet.list());

    app.post('/api/v1/rollouts', { config: { guard: { action: 'hub.update' } } }, async (req, reply) =>
      reply.status(201).send(await fleet.createRollout(parse(rolloutCreateSchema, req.body), staffIdOf(req))),
    );

    app.get('/api/v1/rollouts/:rolloutId', { config: { guard: { action: 'rollout.read' } } }, async (req) => {
      const r = await fleet.get(idOf(req, 'rolloutId'), true);
      if (!r) throw notFound();
      return r;
    });

    app.post('/api/v1/rollouts/:rolloutId/halt', { config: { guard: { action: 'rollout.manage' } } }, async (req) =>
      fleet.halt(idOf(req, 'rolloutId'), parse(rolloutActionSchema, req.body).reason, `staff:${staffIdOf(req)}`),
    );

    app.post('/api/v1/rollouts/:rolloutId/resume', { config: { guard: { action: 'rollout.manage' } } }, async (req) =>
      fleet.resume(idOf(req, 'rolloutId'), parse(rolloutActionSchema, req.body).reason, staffIdOf(req)),
    );

    app.post('/api/v1/rollouts/:rolloutId/cancel', { config: { guard: { action: 'rollout.manage' } } }, async (req) =>
      fleet.cancel(idOf(req, 'rolloutId'), parse(rolloutActionSchema, req.body).reason, staffIdOf(req)),
    );
  };
}
