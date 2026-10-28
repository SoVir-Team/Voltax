import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { brokerAllows, CLOUD_SERVICE_USER } from './broker.js';
import type { HomesService } from './homes.js';

/** Constant-time string comparison. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** Broker login check shared by EMQX (HTTP) and the test brokers. */
export async function brokerAuthenticate(homes: HomesService, cloudServicePassword: string, username: string, password: string): Promise<boolean> {
  if (username === CLOUD_SERVICE_USER) return sameSecret(password, cloudServicePassword);
  return homes.verifyHubSecret(username, password);
}

/**
 * Internal-only HTTP service for the cloud broker (EMQX HTTP authentication + authorisation).
 * Listens on the private Docker network, never published through Caddy, and requires a shared
 * secret header that EMQX sends.
 */
export async function buildInternalApi(deps: { homes: HomesService; cloudServicePassword: string; sharedSecret: string }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 });
  app.addHook('onRequest', async (req, reply) => {
    const given = req.headers['x-voltax-broker-secret'];
    if (typeof given !== 'string' || !sameSecret(given, deps.sharedSecret)) return reply.status(401).send({ result: 'deny' });
  });
  const authn = z.object({ username: z.string().max(128), password: z.string().max(256) });
  const authz = z.object({ username: z.string().max(128), topic: z.string().max(256), action: z.enum(['publish', 'subscribe']) });

  app.post('/broker/authn', async (req) => {
    const body = authn.safeParse(req.body);
    if (!body.success) return { result: 'deny' };
    const ok = await brokerAuthenticate(deps.homes, deps.cloudServicePassword, body.data.username, body.data.password);
    return { result: ok ? 'allow' : 'deny', is_superuser: false };
  });

  app.post('/broker/authz', async (req) => {
    const body = authz.safeParse(req.body);
    if (!body.success) return { result: 'deny' };
    return { result: brokerAllows(body.data.username, body.data.action, body.data.topic) ? 'allow' : 'deny' };
  });

  return app;
}
