import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '../src/crypto.js';
import { startCloud, type TestCloud, type TestStaff } from './helpers.js';

let c: TestCloud;
let admin: TestStaff;
beforeAll(async () => {
  c = await startCloud();
  admin = await c.addStaff('PLATFORM_SUPER_ADMIN');
});
afterAll(async () => {
  await c.close();
});

describe('assignments', () => {
  it('access ends the moment an assignment is revoked', async () => {
    const s = await c.addStaff('PLATFORM_SUPPORT');
    const home = await c.addHome();
    const assignment = await c.assign(s.staffId, home);
    expect((await c.req('GET', `/api/v1/homes/${home}`, { cookie: s.cookie })).status).toBe(200);
    expect((await c.req('DELETE', `/api/v1/assignments/${assignment}`, { cookie: admin.cookie })).status).toBe(200);
    expect((await c.req('GET', `/api/v1/homes/${home}`, { cookie: s.cookie })).status).toBe(404);
    expect((await c.req('GET', '/api/v1/homes', { cookie: s.cookie })).body).toEqual([]);
  });

  it('an expired assignment gives no access', async () => {
    const s = await c.addStaff('INSTALLER');
    const home = await c.addHome();
    await c.assign(s.staffId, home, Date.now() + 60_000);
    expect((await c.req('GET', `/api/v1/homes/${home}`, { cookie: s.cookie })).status).toBe(200);
    await c.db.query('UPDATE assignments SET expires_at = $2 WHERE staff_id = $1', [s.staffId, Date.now() - 1]);
    expect((await c.req('GET', `/api/v1/homes/${home}`, { cookie: s.cookie })).status).toBe(404);
  });

  it('super admins are never assigned to homes, and past expiry dates are refused', async () => {
    const other = await c.addStaff('PLATFORM_SUPER_ADMIN');
    const home = await c.addHome();
    expect((await c.req('POST', '/api/v1/assignments', { cookie: admin.cookie, body: { staffId: other.staffId, homeId: home } })).status).toBe(400);
    const s = await c.addStaff('INSTALLER');
    expect((await c.req('POST', '/api/v1/assignments', { cookie: admin.cookie, body: { staffId: s.staffId, homeId: home, expiresAt: Date.now() - 1000 } })).status).toBe(400);
    expect((await c.req('POST', '/api/v1/assignments', { cookie: admin.cookie, body: { staffId: randomUUID(), homeId: home } })).status).toBe(404);
  });

  it('changing a staff member’s role drops all their assignments', async () => {
    const s = await c.addStaff('INSTALLER');
    const home = await c.addHome();
    await c.assign(s.staffId, home);
    await c.req('PATCH', `/api/v1/staff/${s.staffId}`, { cookie: admin.cookie, body: { role: 'PLATFORM_SUPPORT' } });
    expect((await c.req('GET', `/api/v1/homes/${home}`, { cookie: s.cookie })).status).toBe(404);
  });
});

describe('hubs', () => {
  it('registration returns the broker password once and stores only its hash', async () => {
    const home = await c.addHome();
    const res = await c.req('POST', `/api/v1/homes/${home}/hub`, { cookie: admin.cookie, body: { hubId: 'hub-reg-test' } });
    expect(res.status).toBe(201);
    expect(res.body.brokerUsername).toBe('hub-reg-test');
    const password = res.body.brokerPassword as string;
    expect(password.length).toBeGreaterThanOrEqual(43);
    const [row] = await c.db.query<{ broker_secret_hash: string }>('SELECT broker_secret_hash FROM hubs WHERE hub_id = $1', ['hub-reg-test']);
    expect(row!.broker_secret_hash).toBe(sha256(password));
    expect(JSON.stringify(await c.db.query('SELECT * FROM hubs'))).not.toContain(password);
    expect(JSON.stringify(await c.db.query('SELECT details FROM audit_log'))).not.toContain(password);
    expect(await c.homes.verifyHubSecret('hub-reg-test', password)).toBe(true);
    expect(await c.homes.verifyHubSecret('hub-reg-test', 'guess')).toBe(false);
    expect((await c.req('GET', `/api/v1/homes/${home}/hub`, { cookie: admin.cookie })).body).not.toHaveProperty('brokerPassword');
  });

  it('re-registering rotates the credential; the old one stops working', async () => {
    const home = await c.addHome();
    const first = (await c.req('POST', `/api/v1/homes/${home}/hub`, { cookie: admin.cookie, body: { hubId: 'hub-rotate' } })).body;
    const second = await c.req('POST', `/api/v1/homes/${home}/hub`, { cookie: admin.cookie, body: { hubId: 'hub-rotate' } });
    expect(second.status).toBe(200);
    expect(second.body.rotated).toBe(true);
    expect(await c.homes.verifyHubSecret('hub-rotate', first.brokerPassword)).toBe(false);
    expect(await c.homes.verifyHubSecret('hub-rotate', second.body.brokerPassword)).toBe(true);
  });

  it('a hub id cannot be moved to another home, and a home cannot get a second hub', async () => {
    const a = await c.addHome();
    const b = await c.addHome();
    await c.req('POST', `/api/v1/homes/${a}/hub`, { cookie: admin.cookie, body: { hubId: 'hub-owned' } });
    expect((await c.req('POST', `/api/v1/homes/${b}/hub`, { cookie: admin.cookie, body: { hubId: 'hub-owned' } })).status).toBe(409);
    expect((await c.req('POST', `/api/v1/homes/${a}/hub`, { cookie: admin.cookie, body: { hubId: 'hub-second' } })).status).toBe(409);
    expect((await c.req('POST', `/api/v1/homes/${a}/hub`, { cookie: admin.cookie, body: { hubId: 'BAD ID' } })).status).toBe(400);
  });

  it('device list exposes only ids and online flags from telemetry, never device state', async () => {
    const home = await c.addHome();
    await c.homes.registerHub(home, 'hub-devices', admin.staffId);
    const telemetry = {
      version: '1.0.0',
      uptime: 10,
      db: 'up',
      mqtt: 'up',
      timeSynced: true,
      devices: [
        { deviceId: 'kitchen', online: true },
        { deviceId: 'porch', online: false },
      ],
      update: { state: 'idle' },
      at: Date.now(),
    };
    await c.db.query('UPDATE hubs SET telemetry = $2, last_seen_at = $3 WHERE hub_id = $1', ['hub-devices', JSON.stringify(telemetry), Date.now()]);
    const devices = (await c.req('GET', `/api/v1/homes/${home}/devices`, { cookie: admin.cookie })).body;
    expect(devices).toEqual([
      { deviceId: 'kitchen', online: true },
      { deviceId: 'porch', online: false },
    ]);
    const hub = (await c.req('GET', `/api/v1/homes/${home}/hub`, { cookie: admin.cookie })).body;
    expect(hub).toMatchObject({ online: true, version: '1.0.0', devicesOnline: 1, devicesTotal: 2 });
  });
});

describe('audit chain', () => {
  it('is append-only in the database (update, delete, truncate refused)', async () => {
    await c.audit.append({ actor: 'system', action: 'test.append', outcome: 'ok' });
    await expect(c.db.query("UPDATE audit_log SET actor = 'evil'")).rejects.toThrow(/append-only/);
    await expect(c.db.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/);
    await expect(c.db.query('TRUNCATE audit_log')).rejects.toThrow(/append-only/);
  });

  it('verifies end to end through the API, and every action so far is chained', async () => {
    const res = await c.req('POST', '/api/v1/audit/verify', { cookie: admin.cookie });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.count).toBeGreaterThan(10);
  });

  it('detects an edit made by someone who bypasses the triggers (database owner)', async () => {
    const own = await startCloud();
    try {
      for (let i = 0; i < 3; i++) await own.audit.append({ actor: 'system', action: `test.${i}`, outcome: 'ok' });
      await own.db.exec("ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update; UPDATE audit_log SET actor = 'someone-else' WHERE action = 'test.1'");
      const result = await own.audit.verify();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/content/);
    } finally {
      await own.close();
    }
  });
});
