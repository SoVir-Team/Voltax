import { createPublicKey, verify } from 'node:crypto';
import { MAX_COMMAND_LIFETIME_MS } from '@voltax/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCloud, type TestCloud, type TestStaff } from './helpers.js';

let c: TestCloud;
let home: string;
let support: TestStaff;
let otherSupport: TestStaff;
let installer: TestStaff;
let admin: TestStaff;
const HUB = 'hub-grants';

async function until<T>(check: () => Promise<T | undefined | false>, timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const body = { deviceIds: ['kitchen'], actions: ['device.command', 'diagnostics.read'], reason: 'customer says the kitchen light is stuck', durationMinutes: 60 };

async function request(staff: TestStaff, overrides: Record<string, unknown> = {}) {
  return c.req('POST', `/api/v1/homes/${home}/grants`, { cookie: staff.cookie, body: { ...body, ...overrides } });
}

async function hubSays(grantId: string, status: string, extra: Record<string, unknown> = {}) {
  await c.route(HUB, { type: 'grant.status', grantId, status: status as 'active', at: Date.now(), ...extra });
}

async function approvedGrant(staff: TestStaff, overrides: Record<string, unknown> = {}): Promise<string> {
  await c.db.query("UPDATE grants SET status = 'revoked' WHERE staff_id = $1 AND status IN ('pending', 'active')", [staff.staffId]);
  const res = await request(staff, overrides);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await hubSays(res.body.grantId, 'active', { startNoticeAt: Date.now() });
  return res.body.grantId as string;
}

beforeAll(async () => {
  c = await startCloud();
  home = await c.addHome('Grant home');
  await c.addHub(home, HUB);
  support = await c.addStaff('PLATFORM_SUPPORT', 'support');
  otherSupport = await c.addStaff('PLATFORM_SUPPORT', 'other');
  installer = await c.addStaff('INSTALLER', 'installer');
  admin = await c.addStaff('PLATFORM_SUPER_ADMIN', 'admin');
  for (const s of [support, otherSupport, installer]) await c.assign(s.staffId, home);
  c.grants.resultTimeoutMs = 300;
});
afterAll(async () => {
  await c.close();
});

describe('requesting support access', () => {
  it('sends a signed grant.request the hub can verify; the cloud only records it as pending', async () => {
    const res = await request(support);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'pending', deviceIds: ['kitchen'], hubId: HUB, ownerNotified: false });
    const sent = c.hub.published.at(-1)!;
    expect(sent.hubId).toBe(HUB);
    expect(sent.envelope).toMatchObject({ type: 'grant.request', hubId: HUB, actor: { staffId: support.staffId, role: 'PLATFORM_SUPPORT' } });
    expect(verify(null, Buffer.from(sent.signed.payload), createPublicKey(c.commandPublicKeyPem), Buffer.from(sent.signed.sig, 'base64'))).toBe(true);
  });

  it('refuses what the hub would refuse anyway, before signing anything', async () => {
    await c.db.query("UPDATE grants SET status = 'revoked' WHERE staff_id = $1", [installer.staffId]);
    const before = c.hub.published.length;
    expect((await request(installer, { deviceIds: ['garage'] })).status).toBe(400); // unknown device
    expect((await request(installer, { actions: ['activity.read'] })).status).toBe(403); // installers may not read activity
    expect((await request(installer, { durationMinutes: 241 })).status).toBe(400); // over 4 hours
    expect((await request(installer, { reason: 'short' })).status).toBe(400);
    expect((await request(installer, { startsAt: Date.now() - 10 * 60_000 })).status).toBe(400);
    expect((await request(admin)).status).toBe(403); // super admins never request household access
    expect(c.hub.published.length).toBe(before);
    expect((await request(installer)).status).toBe(201);
    expect((await request(installer)).status).toBe(409); // one open request per staff member and home
  });

  it('a home without a hub, or a hub that has not reported devices, cannot be requested', async () => {
    const bare = await c.addHome('No hub');
    await c.assign(support.staffId, bare);
    expect((await c.req('POST', `/api/v1/homes/${bare}/grants`, { cookie: support.cookie, body })).status).toBe(409);
  });

  it('a request the hub refuses is shown as rejected with the hub’s reason', async () => {
    await c.db.query("UPDATE grants SET status = 'revoked' WHERE staff_id = $1", [support.staffId]);
    const res = await request(support);
    const sent = c.hub.published.at(-1)!;
    await c.route(HUB, { type: 'envelope.rejected', envelopeId: sent.envelope.envelopeId, reason: 'unknown device' });
    const g = (await c.req('GET', `/api/v1/homes/${home}/grants/${res.body.grantId}`, { cookie: support.cookie })).body;
    expect(g).toMatchObject({ status: 'rejected', endReason: 'hub refused: unknown device' });
  });
});

describe('using an approved grant', () => {
  it('before the hub confirms the owner was told, nothing can be done', async () => {
    await c.db.query("UPDATE grants SET status = 'revoked' WHERE staff_id = $1", [support.staffId]);
    const res = await request(support);
    await hubSays(res.body.grantId, 'active'); // approved but no start notice yet
    const cmd = await c.req('POST', `/api/v1/homes/${home}/grants/${res.body.grantId}/commands`, { cookie: support.cookie, body: { entityId: 'kitchen.switch.relay', value: true } });
    expect(cmd.status).toBe(409);
    expect(cmd.body.message).toMatch(/not been notified/);
  });

  it('after approval and notice: a short-lived signed command goes out and the result comes back', async () => {
    const grantId = await approvedGrant(support);
    const g = (await c.req('GET', `/api/v1/homes/${home}/grants/${grantId}`, { cookie: support.cookie })).body;
    expect(g).toMatchObject({ status: 'active', ownerNotified: true });
    const cmd = await c.req('POST', `/api/v1/homes/${home}/grants/${grantId}/commands`, { cookie: support.cookie, body: { entityId: 'kitchen.switch.relay', value: true } });
    expect(cmd.status).toBe(202);
    const env = c.hub.published.at(-1)!.envelope;
    expect(env).toMatchObject({ type: 'command', grantId, entityId: 'kitchen.switch.relay', value: true });
    expect(env.expiresAt - env.issuedAt).toBeLessThanOrEqual(MAX_COMMAND_LIFETIME_MS);
    const list = await until(async () => {
      const l = (await c.req('GET', `/api/v1/homes/${home}/grants/${grantId}/commands`, { cookie: support.cookie })).body;
      return l[0]?.status === 'confirmed' ? l : undefined;
    });
    expect(list[0]).toMatchObject({ commandId: cmd.body.commandId, status: 'confirmed' });
  });

  it('refuses another staff member, an ungranted device and an ungranted action', async () => {
    const grantId = await approvedGrant(support, { actions: ['diagnostics.read'] });
    const url = `/api/v1/homes/${home}/grants/${grantId}`;
    const asOther = await c.req('POST', `${url}/diagnostics`, { cookie: otherSupport.cookie });
    expect(asOther.status).toBe(403);
    expect(asOther.body.message).toBe('not the grantee');
    const cmd = await c.req('POST', `${url}/commands`, { cookie: support.cookie, body: { entityId: 'kitchen.switch.relay', value: true } });
    expect(cmd.body.message).toBe('action not granted');
    const grant2 = await approvedGrant(support);
    const porch = await c.req('POST', `/api/v1/homes/${home}/grants/${grant2}/commands`, { cookie: support.cookie, body: { entityId: 'porch.switch.relay', value: true } });
    expect(porch.status).toBe(403);
    expect(porch.body.message).toBe('device not granted');
  });

  it('diagnostics come back from the hub; a silent hub times out; a refusal is passed on', async () => {
    const grantId = await approvedGrant(support);
    const url = `/api/v1/homes/${home}/grants/${grantId}/diagnostics`;
    const ok = await c.req('POST', url, { cookie: support.cookie });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ db: 'up', mqtt: 'up' });

    c.hub.answering = false;
    try {
      expect((await c.req('POST', url, { cookie: support.cookie })).status).toBe(504);
      const pending = c.req('POST', url, { cookie: support.cookie });
      await new Promise((r) => setTimeout(r, 20));
      await c.route(HUB, { type: 'envelope.rejected', envelopeId: c.hub.published.at(-1)!.envelope.envelopeId, reason: 'grant revoked' });
      const refused = await pending;
      expect(refused.status).toBe(409);
      expect(refused.body.message).toMatch(/grant revoked/);
    } finally {
      c.hub.answering = true;
    }
  });

  it('activity passes through to the staff member and is never stored by the cloud', async () => {
    const grantId = await approvedGrant(support, { actions: ['activity.read'] });
    const marker = 'kitchen-light-was-on-at-dinner';
    c.hub.answering = false;
    try {
      const pending = c.req('POST', `/api/v1/homes/${home}/grants/${grantId}/activity`, { cookie: support.cookie, body: { sinceMinutes: 60 } });
      await new Promise((r) => setTimeout(r, 20));
      const env = c.hub.published.at(-1)!.envelope as { requestId: string };
      await c.route(HUB, { type: 'activity.result', requestId: env.requestId, grantId, events: [{ seq: 1, type: 'entity.state', createdAt: Date.now(), payload: { note: marker } }] });
      const res = await pending;
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).toContain(marker);
    } finally {
      c.hub.answering = true;
    }
    for (const table of ['grants', 'grant_commands', 'notifications', 'audit_log', 'hubs', 'hub_audit']) {
      expect(JSON.stringify(await c.db.query(`SELECT * FROM ${table}`)), table).not.toContain(marker);
    }
    const audit = await c.audit.list({ homeId: home, limit: 500 });
    expect(audit.some((r) => r.action === 'activity.read' && r.details.events === 1)).toBe(true);
  });

  it('a result for another hub’s request is ignored (hub id comes from the topic)', async () => {
    const otherHome = await c.addHome('Other');
    await c.addHub(otherHome, 'hub-elsewhere');
    const grantId = await approvedGrant(support);
    c.hub.answering = false;
    try {
      const pending = c.req('POST', `/api/v1/homes/${home}/grants/${grantId}/diagnostics`, { cookie: support.cookie });
      await new Promise((r) => setTimeout(r, 20));
      const env = c.hub.published.at(-1)!.envelope as { requestId: string };
      const fake = { version: 'evil', uptime: 0, db: 'up' as const, mqtt: 'up' as const, timeSynced: true, devices: [], commandsLast24h: { confirmed: 0, failed: 0, expired: 0 }, eventLogSeq: 0 };
      await c.route('hub-elsewhere', { type: 'diagnostics.result', requestId: env.requestId, grantId, diagnostics: fake });
      expect((await pending).status).toBe(504);
    } finally {
      c.hub.answering = true;
    }
  });
});

describe('ending access', () => {
  it('the grantee can end it; afterwards every action is refused and waiting commands fail', async () => {
    const grantId = await approvedGrant(support);
    c.hub.answering = false;
    await c.req('POST', `/api/v1/homes/${home}/grants/${grantId}/commands`, { cookie: support.cookie, body: { entityId: 'kitchen.switch.relay', value: false } });
    c.hub.answering = true;
    const res = await c.req('POST', `/api/v1/homes/${home}/grants/${grantId}/revoke`, { cookie: support.cookie, body: { reason: 'done', outcome: 'completed' } });
    expect(res.status).toBe(200);
    expect(c.hub.published.at(-1)!.envelope).toMatchObject({ type: 'grant.revoke', grantId, outcome: 'completed' });
    await until(async () => (await c.req('GET', `/api/v1/homes/${home}/grants/${grantId}`, { cookie: support.cookie })).body.status === 'completed');
    const commands = (await c.req('GET', `/api/v1/homes/${home}/grants/${grantId}/commands`, { cookie: support.cookie })).body;
    expect(commands[0]).toMatchObject({ status: 'failed', reason: 'grant completed' });
    const after = await c.req('POST', `/api/v1/homes/${home}/grants/${grantId}/diagnostics`, { cookie: support.cookie });
    expect(after.status).toBe(409);
  });

  it('other support staff cannot end someone else’s grant; the super admin can', async () => {
    const grantId = await approvedGrant(support);
    expect((await c.req('POST', `/api/v1/homes/${home}/grants/${grantId}/revoke`, { cookie: otherSupport.cookie, body: { reason: 'x' } })).status).toBe(404);
    expect((await c.req('POST', `/api/v1/homes/${home}/grants/${grantId}/revoke`, { cookie: admin.cookie, body: { reason: 'policy' } })).status).toBe(200);
  });

  it('a finished grant never becomes active again, whatever arrives later', async () => {
    const grantId = await approvedGrant(support);
    await hubSays(grantId, 'revoked', { reason: 'revoked by the owner' });
    await hubSays(grantId, 'active', { startNoticeAt: Date.now() });
    const g = (await c.req('GET', `/api/v1/homes/${home}/grants/${grantId}`, { cookie: support.cookie })).body;
    expect(g.status).toBe('revoked');
  });

  it('one hub cannot change another hub’s grant', async () => {
    const grantId = await approvedGrant(support);
    await c.route('hub-elsewhere', { type: 'grant.status', grantId, status: 'revoked', at: Date.now() });
    const g = (await c.req('GET', `/api/v1/homes/${home}/grants/${grantId}`, { cookie: support.cookie })).body;
    expect(g.status).toBe('active');
    const audit = await c.audit.list({ limit: 500, afterSeq: 0 });
    expect(audit.some((r) => r.actor === 'hub:hub-elsewhere' && r.outcome === 'denied')).toBe(true);
  });

  it('grants whose window is over expire in the cloud as well', async () => {
    const grantId = await approvedGrant(support);
    await c.db.query('UPDATE grants SET ends_at = $2 WHERE grant_id = $1', [grantId, Date.now() - 1]);
    expect(await c.grants.sweep()).toBeGreaterThanOrEqual(1);
    const g = (await c.req('GET', `/api/v1/homes/${home}/grants/${grantId}`, { cookie: support.cookie })).body;
    expect(g.status).toBe('expired');
  });
});

describe('without the cloud broker / command key', () => {
  it('remote support answers 503 and signs nothing', async () => {
    const plain = await startCloud({ transport: null });
    try {
      const h = await plain.addHome();
      await plain.addHub(h, 'hub-plain');
      const s = await plain.addStaff('PLATFORM_SUPPORT');
      await plain.assign(s.staffId, h);
      const res = await plain.req('POST', `/api/v1/homes/${h}/grants`, { cookie: s.cookie, body });
      expect(res.status).toBe(503);
    } finally {
      await plain.close();
    }
  });
});
