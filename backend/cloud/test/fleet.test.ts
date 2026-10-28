import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CloudEnvelope, RolloutView } from '@voltax/contracts';
import { firmwareRelease, hubRelease, startCloud, type TestCloud, type TestStaff } from './helpers.js';

// Fleet: signed release registry and staged hub rollouts. Hubs are simulated by feeding their
// update.status answers into cloud.route(), exactly what the broker link does.

let c: TestCloud;
let admin: TestStaff;
let support: TestStaff;
const hubs: string[] = [];
let clock = Date.now();
const MIN = 60_000;

const offersTo = (rolloutId: string, type: CloudEnvelope['type'] = 'hub.update') =>
  c.hub.published.filter((p) => p.envelope.type === type && 'rolloutId' in p.envelope && p.envelope.rolloutId === rolloutId);
const status = (hubId: string, rolloutId: string, state: string, version = '1.8.0') => c.route(hubId, { type: 'update.status', rolloutId, state: state as 'done', version });
const view = async (id: string) => (await c.fleet.get(id, true)) as Required<RolloutView>;
const targetsIn = async (id: string, state: string) => (await view(id)).targets.filter((t) => t.state === state);

let n = 0;
const nextVersion = () => `1.8.${n++}`;
async function register(version = nextVersion(), opts: { minFromVersion?: string } = {}) {
  const res = await c.req('POST', '/api/v1/releases', { cookie: admin.cookie, body: hubRelease(version, opts) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.releaseId as string;
}

async function startRollout(releaseId: string, body: Record<string, unknown> = {}) {
  const res = await c.req('POST', '/api/v1/rollouts', { cookie: admin.cookie, body: { releaseId, healthWindowMinutes: 30, ...body } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as RolloutView;
}

/** Every hub offered so far reports done and then telemetry with the new version. */
async function completeOffered(rolloutId: string) {
  const version = (await view(rolloutId)).release.version;
  for (const t of await targetsIn(rolloutId, 'offered')) {
    await status(t.hubId, rolloutId, 'done', version);
    await c.setHubVersion(t.hubId, version);
  }
}

beforeAll(async () => {
  c = await startCloud();
  c.fleet.now = () => clock;
  admin = await c.addStaff('PLATFORM_SUPER_ADMIN', 'Fleet Admin');
  support = await c.addStaff('PLATFORM_SUPPORT');
  for (let i = 0; i < 20; i++) {
    const home = await c.addHome(`Fleet home ${i}`);
    const hubId = `fleet-hub-${String(i).padStart(2, '0')}`;
    await c.addHub(home, hubId);
    hubs.push(hubId);
  }
});
afterAll(async () => {
  await c.close();
});
beforeEach(async () => {
  clock = Date.now();
  for (const h of hubs) await c.setHubVersion(h, '1.3.0');
  await c.db.query("UPDATE rollouts SET status = 'cancelled' WHERE status IN ('running', 'halted')");
  c.hub.published.length = 0;
});

describe('release registry: only releases signed with the VOLTEX release key', () => {
  it('registers a signed hub release with key id and trusted comment, and audits it', async () => {
    const id = await register('1.4.0');
    const r = (await c.req('GET', `/api/v1/releases/${id}`, { cookie: admin.cookie })).body;
    expect(r).toMatchObject({ kind: 'hub', version: '1.4.0', trustedComment: 'voltax hub 1.4.0', withdrawnAt: null });
    expect(r.keyId).toMatch(/^[0-9A-F]{16}$/);
    expect((await c.audit.list({ limit: 500 })).some((a) => a.action === 'release.register' && a.outcome === 'ok')).toBe(true);
  });

  it('refuses a signature from another key, a manifest edited after signing, unpinned images and duplicates', async () => {
    const other = hubRelease('1.5.0', { key: generateKeyPairSync('ed25519').privateKey });
    const wrongKey = await c.req('POST', '/api/v1/releases', { cookie: admin.cookie, body: other });
    expect(wrongKey.status).toBe(400);
    expect(wrongKey.body.message).toMatch(/signature/);

    const edited = hubRelease('1.5.0');
    edited.manifest = edited.manifest.replace('1.5.0', '1.5.1');
    expect((await c.req('POST', '/api/v1/releases', { cookie: admin.cookie, body: edited })).body.message).toMatch(/signature does not match/);

    const unpinned = hubRelease('1.5.0');
    const m = JSON.parse(unpinned.manifest);
    m.hubImage = 'ghcr.io/voltex/hub:latest';
    const resigned = { ...hubRelease('1.5.0'), manifest: JSON.stringify(m) };
    resigned.signature = (await import('./helpers.js')).minisignSign(resigned.manifest, 'voltax hub 1.5.0');
    const bad = await c.req('POST', '/api/v1/releases', { cookie: admin.cookie, body: resigned });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/pinned by digest/);

    await register('1.6.0');
    expect((await c.req('POST', '/api/v1/releases', { cookie: admin.cookie, body: hubRelease('1.6.0') })).status).toBe(409);
  });

  it('only the super admin registers releases; support can read them', async () => {
    expect((await c.req('POST', '/api/v1/releases', { cookie: support.cookie, body: hubRelease('1.7.0') })).status).toBe(403);
    expect((await c.req('GET', '/api/v1/releases', { cookie: support.cookie })).status).toBe(200);
  });

  it('ESP32 firmware is registered with its board; rolling it out is blocked until OTA is validated on hardware', async () => {
    const res = await c.req('POST', '/api/v1/releases', { cookie: admin.cookie, body: firmwareRelease('2.1.0', 'esp32c3') });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: 'esp32', board: 'esp32c3' });
    const roll = await c.req('POST', '/api/v1/rollouts', { cookie: admin.cookie, body: { releaseId: res.body.releaseId } });
    expect(roll.status).toBe(409);
    expect(roll.body.message).toMatch(/hardware/);
  });
});

describe('compatibility', () => {
  it('a hub is eligible only when older than the release and new enough to jump straight to it', async () => {
    const id = await register('2.0.0', { minFromVersion: '1.3.0' });
    await c.setHubVersion(hubs[0]!, '2.0.0');
    await c.setHubVersion(hubs[1]!, '1.2.0');
    await c.setHubVersion(hubs[2]!, 'dev');
    const list = (await c.req('GET', `/api/v1/releases/${id}/compatibility`, { cookie: admin.cookie })).body as Array<{ hubId: string; eligible: boolean; reason: string }>;
    const of = (h: string) => list.find((x) => x.hubId === h)!;
    expect(of(hubs[0]!)).toMatchObject({ eligible: false, reason: 'already on this version or newer' });
    expect(of(hubs[1]!)).toMatchObject({ eligible: false, reason: 'needs 1.3.0 or later first' });
    expect(of(hubs[2]!)).toMatchObject({ eligible: false, reason: 'not running a release version' });
    expect(of(hubs[3]!)).toMatchObject({ eligible: true });
  });
});

describe('staged rollout: canary, stages, thresholds, halt', () => {
  it('starts with one canary hub; the offer is a signed hub.update from the super admin', async () => {
    const r = await startRollout(await register());
    expect(r).toMatchObject({ status: 'running', stage: 0, stages: [10, 50, 100] });
    const offers = offersTo(r.rolloutId);
    expect(offers).toHaveLength(1);
    const { envelope, signed } = offers[0]!;
    expect(envelope).toMatchObject({ type: 'hub.update', version: r.release.version, actor: { role: 'PLATFORM_SUPER_ADMIN', displayName: 'Fleet Admin' } });
    expect(verify(null, Buffer.from(signed.payload), createPublicKey(c.commandPublicKeyPem), Buffer.from(signed.sig, 'base64'))).toBe(true);
    expect((await view(r.rolloutId)).counts).toMatchObject({ offered: 1, pending: 19 });
    expect((await c.req('POST', '/api/v1/rollouts', { cookie: admin.cookie, body: { releaseId: r.release.releaseId } })).status).toBe(409); // one at a time
  });

  it('moves stage by stage only after the health window, with updated hubs reporting the new version', async () => {
    const r = await startRollout(await register());
    await completeOffered(r.rolloutId);
    await c.fleet.tick();
    expect((await view(r.rolloutId)).stage).toBe(0); // health window not over

    clock += 31 * MIN;
    await c.fleet.tick();
    let v = await view(r.rolloutId);
    expect(v.stage).toBe(1); // 10% of 20 = 2 hubs in total
    expect(v.counts).toMatchObject({ done: 1, offered: 1 });

    await completeOffered(r.rolloutId);
    clock += 31 * MIN;
    await c.fleet.tick();
    v = await view(r.rolloutId);
    expect(v.stage).toBe(2); // 50% = 10 in total
    expect(v.counts).toMatchObject({ done: 2, offered: 8 });

    await completeOffered(r.rolloutId);
    clock += 31 * MIN;
    await c.fleet.tick();
    await completeOffered(r.rolloutId);
    clock += 31 * MIN;
    await c.fleet.tick();
    v = await view(r.rolloutId);
    expect(v.status).toBe('completed');
    expect(v.counts).toMatchObject({ done: 20 });
    expect((await c.audit.list({ limit: 1000 })).filter((a) => a.action === 'rollout.stage').length).toBe(3);
  });

  it('a failed canary halts the rollout at once and nothing else is offered', async () => {
    const r = await startRollout(await register());
    const canary = (await targetsIn(r.rolloutId, 'offered'))[0]!.hubId;
    await status(canary, r.rolloutId, 'rolled_back');
    await c.fleet.tick();
    const v = await view(r.rolloutId);
    expect(v).toMatchObject({ status: 'halted' });
    expect(v.haltReason).toMatch(/failure/);
    clock += 120 * MIN;
    await c.fleet.tick();
    expect(offersTo(r.rolloutId)).toHaveLength(1);
  });

  it('halts when failures pass the threshold and withdraws offers the owners have not decided', async () => {
    const r = await startRollout(await register(), { stages: [50, 100], maxFailureRate: 0.1 });
    await completeOffered(r.rolloutId);
    clock += 31 * MIN;
    await c.fleet.tick(); // stage 1: 10 hubs offered in total
    const offered = await targetsIn(r.rolloutId, 'offered');
    expect(offered).toHaveLength(9);
    await status(offered[0]!.hubId, r.rolloutId, 'awaiting_approval');
    await status(offered[1]!.hubId, r.rolloutId, 'failed');
    await status(offered[2]!.hubId, r.rolloutId, 'rolled_back'); // 2 of 10 = 20% > 10%
    await c.fleet.tick();
    expect((await view(r.rolloutId)).status).toBe('halted');
    const withdrawn = offersTo(r.rolloutId, 'hub.update.withdraw').map((o) => o.hubId);
    expect(withdrawn).toContain(offered[0]!.hubId); // awaiting the owner
    expect(withdrawn).not.toContain(offered[1]!.hubId); // already failed: nothing to take back
  });

  it('an owner who declines is not a failure, and waiting owners do not block the next stage', async () => {
    const r = await startRollout(await register(), { stages: [50, 100] });
    await completeOffered(r.rolloutId);
    clock += 31 * MIN;
    await c.fleet.tick();
    const offered = await targetsIn(r.rolloutId, 'offered');
    await status(offered[0]!.hubId, r.rolloutId, 'declined');
    await status(offered[1]!.hubId, r.rolloutId, 'awaiting_approval');
    for (const t of offered.slice(2)) {
      await status(t.hubId, r.rolloutId, 'done');
      await c.setHubVersion(t.hubId, r.release.version);
    }
    clock += 31 * MIN;
    await c.fleet.tick();
    const v = await view(r.rolloutId);
    expect(v).toMatchObject({ status: 'running', stage: 2 });
    expect(v.counts).toMatchObject({ declined: 1, awaiting_approval: 1 });
  });

  it('a hub that reports "done" but keeps running the old version counts as a failure', async () => {
    const r = await startRollout(await register());
    const canary = (await targetsIn(r.rolloutId, 'offered'))[0]!.hubId;
    await status(canary, r.rolloutId, 'done'); // telemetry still says 1.3.0
    clock += 31 * MIN;
    await c.fleet.tick();
    const v = await view(r.rolloutId);
    expect(v.status).toBe('halted');
    expect(v.targets.find((t) => t.hubId === canary)!.detail).toMatch(/still reports 1\.3\.0/);
  });

  it('an offline hub stays pending and gets its offer when it is back', async () => {
    c.hub.answering = false;
    const failing = c.hub.published.length;
    const original = c.fleet.transport;
    c.fleet.transport = { publish: async () => Promise.reject(new Error('cloud broker not connected')) };
    try {
      const r = await startRollout(await register());
      expect((await view(r.rolloutId)).counts).toMatchObject({ pending: 20 });
      c.fleet.transport = original;
      await c.fleet.tick();
      expect((await view(r.rolloutId)).counts).toMatchObject({ offered: 1 });
      expect(c.hub.published.length).toBe(failing + 1);
    } finally {
      c.fleet.transport = original;
      c.hub.answering = true;
    }
  });

  it('re-checks the creator at every step: once no longer a super admin, the rollout halts', async () => {
    const creator = await c.addStaff('PLATFORM_SUPER_ADMIN', 'Leaving Admin');
    const id = (await c.req('POST', '/api/v1/releases', { cookie: creator.cookie, body: hubRelease(nextVersion()) })).body.releaseId as string;
    const r = (await c.req('POST', '/api/v1/rollouts', { cookie: creator.cookie, body: { releaseId: id, healthWindowMinutes: 30 } })).body as RolloutView;
    await completeOffered(r.rolloutId);
    await c.req('PATCH', `/api/v1/staff/${creator.staffId}`, { cookie: admin.cookie, body: { role: 'PLATFORM_SUPPORT' } });
    clock += 31 * MIN;
    await c.fleet.tick();
    const v = await view(r.rolloutId);
    expect(v.status).toBe('halted');
    expect(v.haltReason).toMatch(/no longer a super admin/);
    expect(offersTo(r.rolloutId)).toHaveLength(1);
  });

  it('halt, resume and cancel are super-admin actions with a reason, and are audited', async () => {
    const r = await startRollout(await register());
    expect((await c.req('POST', `/api/v1/rollouts/${r.rolloutId}/halt`, { cookie: support.cookie, body: { reason: 'looks wrong' } })).status).toBe(403);
    expect((await c.req('POST', `/api/v1/rollouts/${r.rolloutId}/halt`, { cookie: admin.cookie, body: { reason: 'customer reports' } })).body.status).toBe('halted');
    expect((await c.req('POST', `/api/v1/rollouts/${r.rolloutId}/resume`, { cookie: admin.cookie, body: { reason: 'false alarm' } })).body.status).toBe('running');
    const cancelled = (await c.req('POST', `/api/v1/rollouts/${r.rolloutId}/cancel`, { cookie: admin.cookie, body: { reason: 'superseded' } })).body;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.counts).toMatchObject({ skipped: 19 });
    expect((await c.req('POST', `/api/v1/rollouts/${r.rolloutId}/resume`, { cookie: admin.cookie, body: { reason: 'again' } })).status).toBe(409);
    const actions = (await c.audit.list({ limit: 2000 })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['rollout.create', 'rollout.halt', 'rollout.resume', 'rollout.cancel']));
  });

  it('a withdrawn release halts its rollout and cannot start a new one', async () => {
    const id = await register();
    const r = await startRollout(id);
    expect((await c.req('POST', `/api/v1/releases/${id}/withdraw`, { cookie: admin.cookie, body: { reason: 'bad build' } })).status).toBe(200);
    expect((await view(r.rolloutId)).status).toBe('halted');
    await c.db.query("UPDATE rollouts SET status = 'cancelled' WHERE id = $1", [r.rolloutId]);
    expect((await c.req('POST', '/api/v1/rollouts', { cookie: admin.cookie, body: { releaseId: id } })).status).toBe(409);
  });

  it('status for a rollout the hub is not part of changes nothing', async () => {
    const r = await startRollout(await register());
    const canary = (await targetsIn(r.rolloutId, 'offered'))[0]!.hubId;
    const other = hubs.find((h) => h !== canary)!;
    await status(other, r.rolloutId, 'done');
    expect((await view(r.rolloutId)).targets.find((t) => t.hubId === other)!.state).toBe('pending');
  });

  it('fleet summary counts versions and update states without household data', async () => {
    const s = (await c.req('GET', '/api/v1/fleet/summary', { cookie: admin.cookie })).body;
    expect(s.hubs).toBeGreaterThanOrEqual(20);
    expect(s.versions['1.3.0']).toBeGreaterThanOrEqual(20);
    expect(JSON.stringify(s)).not.toMatch(/kitchen|porch|deviceId/);
    expect((await c.req('GET', '/api/v1/fleet/summary', { cookie: support.cookie })).status).toBe(200);
  });
});
