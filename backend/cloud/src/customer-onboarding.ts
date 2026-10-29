import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Actor, HubMessage, SignedEnvelope } from '@voltax/contracts';
import type { FastifyInstance } from 'fastify';
import { homeIdOf, parse } from './api.js';
import { CloudError, conflict } from './errors.js';
import type { HomesService } from './homes.js';
import type { EnvelopeSigner } from './signer.js';
import type { CloudAudit } from './audit.js';

type Result = Extract<HubMessage, { type: 'customer.onboard.result' }>['result'];
/** Codes are returned only to the requesting admin; neither codes nor customer credentials are stored in the cloud. */
export class CustomerOnboarding {
  private states = new Map<string, { challenge: string; claimed: boolean; seen: number }>();
  private pending = new Map<string, { hubId: string; done: (result: Result) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private homes: HomesService, private audit: CloudAudit, private signer: EnvelopeSigner | null, private transport: { publish(hubId: string, env: SignedEnvelope): Promise<void> }) {}
  handle(hubId: string, message: Extract<HubMessage, { type: 'customer.ready' | 'customer.onboard.result' }>): void {
    if (message.type === 'customer.ready') { this.states.set(hubId, { challenge: message.challenge, claimed: message.claimed, seen: Date.now() }); return; }
    const pending = this.pending.get(message.requestId);
    if (!pending || pending.hubId !== hubId) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.requestId);
    pending.done(message.result);
  }
  close(): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.done({ ok: false, message: 'Service is stopping. Try again later.' }); }
    this.pending.clear();
  }
  async state(homeId: string) {
    const home = await this.homes.get(homeId);
    const state = home.hub ? this.states.get(home.hub.hubId) : undefined;
    return { available: !!(state && Date.now() - state.seen < 180_000 && home.hub?.online), claimed: state?.claimed ?? null };
  }
  async generate(homeId: string, actor: Actor, email: string) {
    if (actor.role !== 'PLATFORM_SUPER_ADMIN') throw new CloudError(403, 'forbidden', 'Only the platform admin can provision a homeowner.');
    const hubId = await this.homes.hubOf(homeId);
    const state = hubId ? this.states.get(hubId) : undefined;
    if (!hubId || !state || !state.challenge || Date.now() - state.seen > 180_000 || !(await this.state(homeId)).available || !this.signer) throw new CloudError(503, 'hub_unavailable', 'The home hub is unavailable. Start it and try again.');
    if (state.claimed) throw conflict('This home already has a customer owner.');
    if ([...this.pending.values()].some(p => p.hubId === hubId)) throw conflict('A code request is already in progress for this home.');
    const requestId = randomUUID();
    const now = Date.now();
    let resolveResult!: (value: Result) => void;
    const result = new Promise<Result>(resolve => { resolveResult = resolve; });
    const timer = setTimeout(() => { this.pending.delete(requestId); resolveResult({ ok: false, message: 'The home hub did not respond. Try again when it is online.' }); }, 8000);
    this.pending.set(requestId, { hubId, done: resolveResult, timer });
    try {
      const challenge = state.challenge;
      state.challenge = ''; // Each hub challenge is used once, answered or not: the next request waits for a fresh one.
      await this.transport.publish(hubId, this.signer.sign({ v: 1, type: 'customer.onboard', envelopeId: requestId, hubId, actor, email, challenge, issuedAt: now, expiresAt: now + 60_000 }));
      const response = await result;
      if (!response.ok) throw new CloudError(409, 'onboarding_refused', response.message);
      await this.audit.append({ actor: `staff:${actor.staffId}`, action: 'home.onboard', outcome: 'ok', homeId, target: `home:${homeId}` });
      return { code: `${response.code.slice(0,5)}-${response.code.slice(5)}`, expiresAt: response.expiresAt, email: response.email };
    } finally { clearTimeout(timer); this.pending.delete(requestId); }
  }
  routes() {
    return (app: FastifyInstance) => {
      app.get('/api/v1/homes/:homeId/onboarding', { config: { guard: { action: 'home.onboard', home: 'params' } } }, async req => this.state(homeIdOf(req)));
      app.post('/api/v1/homes/:homeId/onboarding', { config: { guard: { action: 'home.onboard', home: 'params' } } }, async req => {
        const { email } = parse(z.object({ email: z.email().max(254).transform(v => v.trim().toLowerCase()) }), req.body);
        const staff = req.auth!.staff;
        return this.generate(homeIdOf(req), { staffId: staff.id, role: staff.role, displayName: staff.display_name }, email);
      });
    };
  }
}
