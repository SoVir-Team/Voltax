import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, HubMessage } from '@voltax/contracts';
import { HUB_ID, pairOwner, startEnv, type TestEnv } from './helpers.js';

// The admin's "Generate owner code" reaches the hub as a signed customer.onboard envelope carrying the
// hub's own fresh challenge. Only a platform super admin, only an unclaimed home, each challenge once.

const cloud = generateKeyPairSync('ed25519');
const attacker = generateKeyPairSync('ed25519');
const pem = cloud.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const admin: Actor = { staffId: randomUUID(), role: 'PLATFORM_SUPER_ADMIN', displayName: 'Admin' };
const support: Actor = { staffId: randomUUID(), role: 'PLATFORM_SUPPORT', displayName: 'Asha' };

let env: TestEnv;
let sent: HubMessage[];
beforeEach(async () => {
  env = await startEnv({ cloudKeyPem: pem, timeSynced: false, connectDevice: false }); // a new hub, clock not synced yet
  sent = [];
  env.hub.grants.setSink((m) => sent.push(m));
});
afterEach(() => env.close());

function onboard(o: { challenge?: string; actor?: Actor; key?: KeyObject } = {}) {
  const now = Date.now();
  const envelope = { v: 1, envelopeId: randomUUID(), hubId: HUB_ID, issuedAt: now, expiresAt: now + 60_000, actor: o.actor ?? admin, type: 'customer.onboard', email: 'owner@example.test', challenge: o.challenge ?? env.hub.customers.ready().challenge };
  const payload = JSON.stringify(envelope);
  return { payload, sig: sign(null, Buffer.from(payload), o.key ?? cloud.privateKey).toString('base64') };
}
const result = () => sent.filter((m) => m.type === 'customer.onboard.result').at(-1) as Extract<HubMessage, { type: 'customer.onboard.result' }> | undefined;
const refusal = () => sent.filter((m) => m.type === 'envelope.rejected').at(-1) as Extract<HubMessage, { type: 'envelope.rejected' }> | undefined;

describe('initial owner code from the admin portal', () => {
  it('the hub creates a 10-character code for the invited email, even before its clock is synced', () => {
    env.hub.grants.handle(onboard());
    expect(result()?.result).toMatchObject({ ok: true, email: 'owner@example.test' });
    const r = result()!.result as { code: string };
    expect(r.code).toMatch(/^[0-9A-Z]{10}$/);
    expect(JSON.stringify(env.hub.db.prepare('SELECT * FROM customer_invitations').all())).not.toContain(r.code); // only its hash
  });

  it('each challenge works once, and a replayed envelope is refused', () => {
    const challenge = env.hub.customers.ready().challenge;
    const first = onboard({ challenge });
    env.hub.grants.handle(first);
    expect(result()?.result.ok).toBe(true);
    env.hub.grants.handle(onboard({ challenge }));
    expect(refusal()?.reason).toBe('invalid onboarding challenge');
    env.hub.grants.handle(first);
    expect(refusal()?.reason).toMatch(/invalid onboarding challenge|replayed/);
  });

  it('refuses a wrong challenge, a role other than super admin and a forged signature', () => {
    env.hub.grants.handle(onboard({ challenge: 'x'.repeat(43) }));
    expect(refusal()?.reason).toBe('invalid onboarding challenge');
    env.hub.grants.handle(onboard({ actor: support }));
    expect(refusal()?.reason).toBe('invalid onboarding challenge');
    env.hub.grants.handle(onboard({ key: attacker.privateKey }));
    expect(refusal()?.reason).toBe('bad signature');
    expect(result()).toBeUndefined();
  });

  it('a home that already has an owner (even one paired before accounts existed) refuses', async () => {
    await pairOwner(env.hub);
    expect(env.hub.customers.ready().claimed).toBe(true);
    env.hub.grants.handle(onboard());
    expect(result()?.result).toEqual({ ok: false, message: 'this home already has a customer owner' });
  });
});
