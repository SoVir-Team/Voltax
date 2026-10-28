import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, HubMessage, HubUpdatesView } from '@voltax/contracts';
import { HUB_ID, pairOwner, startEnv, type TestEnv } from './helpers.js';

// Fleet updates on the hub: the cloud may only OFFER a signed version; the owner's local policy
// decides. The hub never installs anything itself: it drops a request for the root updater, which
// checks the release signature again (P3).
const cloud = generateKeyPairSync('ed25519');
const pem = cloud.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const admin: Actor = { staffId: randomUUID(), role: 'PLATFORM_SUPER_ADMIN', displayName: 'Fleet Admin' };
const support: Actor = { staffId: randomUUID(), role: 'PLATFORM_SUPPORT', displayName: 'Support' };

let env: TestEnv;
let owner: { authorization: string; clientId: string };
let sent: HubMessage[];

function deliver(body: Record<string, unknown>, opts: { actor?: Actor; key?: KeyObject } = {}) {
  const now = Date.now();
  const payload = JSON.stringify({ v: 1, envelopeId: randomUUID(), hubId: HUB_ID, issuedAt: now, expiresAt: now + 60_000, actor: opts.actor ?? admin, ...body });
  env.hub.grants.handle({ payload, sig: sign(null, Buffer.from(payload), opts.key ?? cloud.privateKey).toString('base64') });
}
const offer = (version: string, rolloutId = randomUUID(), actor?: Actor) => {
  deliver({ type: 'hub.update', rolloutId, version }, { actor });
  return rolloutId;
};
const api = async (method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, authorization = owner.authorization) => {
  const res = await env.hub.app.inject({ method, url, headers: { authorization }, ...(body ? { payload: body as object } : {}) });
  return { status: res.statusCode, body: res.json() };
};
const view = async () => (await api('GET', '/api/v1/updates')).body as HubUpdatesView;
const statuses = () => sent.filter((m): m is Extract<HubMessage, { type: 'update.status' }> => m.type === 'update.status');
const lastRejection = () => [...sent].reverse().find((m) => m.type === 'envelope.rejected') as Extract<HubMessage, { type: 'envelope.rejected' }> | undefined;
const requestFile = () => join(env.dir, 'update-request', 'request.json');

beforeEach(async () => {
  env = await startEnv({ cloudKeyPem: pem, timeSynced: true, version: '1.3.0' });
  owner = await pairOwner(env.hub);
  sent = [];
  env.hub.grants.setSink((m) => sent.push(m));
});
afterEach(async () => env.close());

describe('hub updates: the owner decides', () => {
  it('default policy: an offer waits for the owner; approving drops a request for the host updater', async () => {
    const rolloutId = offer('1.4.0');
    expect(existsSync(requestFile())).toBe(false);
    const v = await view();
    expect(v).toMatchObject({ policy: 'approve', currentVersion: '1.3.0', state: { state: 'idle' } });
    expect(v.offers).toEqual([expect.objectContaining({ rolloutId, version: '1.4.0', status: 'pending', offeredBy: 'Fleet Admin' })]);
    expect(statuses()).toEqual([{ type: 'update.status', rolloutId, state: 'awaiting_approval', version: '1.4.0' }]);
    expect(env.hub.events.since(0).some((e) => e.type === 'update.offered')).toBe(true);

    const res = await api('POST', `/api/v1/updates/${rolloutId}/approve`);
    expect(res.status).toBe(200);
    expect(JSON.parse(readFileSync(requestFile(), 'utf8'))).toMatchObject({ version: '1.4.0', rolloutId });
    expect(statuses().at(-1)).toEqual({ type: 'update.status', rolloutId, state: 'requested', version: '1.4.0' });
    expect((await view()).offers[0]).toMatchObject({ status: 'approved', decidedBy: owner.clientId });
    expect(env.hub.audit.since(0).map((r) => r.action)).toEqual(expect.arrayContaining(['update.offer', 'update.approve']));
    expect((await api('POST', `/api/v1/updates/${rolloutId}/approve`)).status).toBe(409); // decided once
  });

  it('the owner can decline: the cloud hears "declined" and nothing is installed', async () => {
    const rolloutId = offer('1.4.0');
    expect((await api('POST', `/api/v1/updates/${rolloutId}/decline`)).status).toBe(200);
    expect(existsSync(requestFile())).toBe(false);
    expect(statuses().at(-1)).toMatchObject({ rolloutId, state: 'declined' });
  });

  it('auto policy (owner choice, audited): a signed offer is requested at once', async () => {
    expect((await api('PUT', '/api/v1/updates/policy', { policy: 'auto' })).status).toBe(200);
    expect(env.hub.audit.since(0).find((r) => r.action === 'update.policy')?.details).toMatchObject({ policy: 'auto' });
    const rolloutId = offer('1.4.0');
    expect(JSON.parse(readFileSync(requestFile(), 'utf8'))).toMatchObject({ version: '1.4.0', rolloutId });
    expect(statuses().at(-1)).toMatchObject({ rolloutId, state: 'requested' });
    expect((await view()).offers[0]).toMatchObject({ status: 'approved', decidedBy: 'policy:auto' });
  });

  it('refuses offers from other roles, downgrades, the same version, and envelopes not signed by the cloud key', async () => {
    offer('1.4.0', randomUUID(), support);
    expect(lastRejection()?.reason).toBe('role may not offer hub updates');
    offer('1.2.9');
    expect(lastRejection()?.reason).toBe('not newer than the installed version');
    offer('1.3.0');
    expect(lastRejection()?.reason).toBe('not newer than the installed version');
    deliver({ type: 'hub.update', rolloutId: randomUUID(), version: '1.4.0' }, { key: generateKeyPairSync('ed25519').privateKey });
    expect(lastRejection()?.reason).toMatch(/signature/);
    expect((await view()).offers).toEqual([]);
  });

  it('a repeated offer for the same rollout is not stored twice and re-reports its state', async () => {
    const rolloutId = offer('1.4.0');
    offer('1.4.0', rolloutId);
    expect((await view()).offers).toHaveLength(1);
    expect(statuses().map((s) => s.state)).toEqual(['awaiting_approval', 'awaiting_approval']);
    offer('1.5.0', rolloutId); // same rollout, different version: refused
    expect(lastRejection()?.reason).toBe('rollout already offered a different version');
  });

  it('a withdrawn offer cannot be approved any more', async () => {
    const rolloutId = offer('1.4.0');
    deliver({ type: 'hub.update.withdraw', rolloutId });
    expect(statuses().at(-1)).toMatchObject({ rolloutId, state: 'withdrawn' });
    expect((await api('POST', `/api/v1/updates/${rolloutId}/approve`)).status).toBe(409);
    expect(existsSync(requestFile())).toBe(false);
  });

  it('members can neither see nor decide updates', async () => {
    const rolloutId = offer('1.4.0');
    const { code } = env.hub.auth.createPairingCode('member');
    const pair = await env.hub.app.inject({ method: 'POST', url: '/api/v1/pair', payload: { pairingCode: code, clientName: 'kid tablet' } });
    const member = `Bearer ${pair.json<{ token: string }>().token}`;
    expect((await api('GET', '/api/v1/updates', undefined, member)).status).toBe(403);
    expect((await api('POST', `/api/v1/updates/${rolloutId}/approve`, undefined, member)).status).toBe(403);
    expect((await api('PUT', '/api/v1/updates/policy', { policy: 'auto' }, member)).status).toBe(403);
  });

  it('reports the host updater outcome once, with the rollout id', async () => {
    const rolloutId = offer('1.4.0');
    await api('POST', `/api/v1/updates/${rolloutId}/approve`);
    // The root updater consumes the request and writes its result (as voltax-update does).
    const dir = join(env.dir, 'update-request');
    rmSync(requestFile());
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'result.json'), JSON.stringify({ version: '1.4.0', state: 'rolled_back', rolloutId, at: Date.now(), message: 'health check failed' }));
    env.hub.updateService.poll();
    env.hub.updateService.poll();
    const outcome = statuses().filter((s) => s.state === 'rolled_back');
    expect(outcome).toEqual([{ type: 'update.status', rolloutId, state: 'rolled_back', version: '1.4.0' }]);
    expect(env.hub.events.since(0).find((e) => e.type === 'update.result')?.payload).toMatchObject({ rolloutId, state: 'rolled_back' });
  });

  it('a development build (no release version) refuses all offers', async () => {
    await env.close();
    env = await startEnv({ cloudKeyPem: pem, timeSynced: true, version: 'dev' });
    owner = await pairOwner(env.hub);
    sent = [];
    env.hub.grants.setSink((m) => sent.push(m));
    offer('1.4.0');
    expect(lastRejection()?.reason).toBe('this hub is not running a release version');
  });
});
