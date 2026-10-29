import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCloud, type TestCloud, type TestStaff } from './helpers.js';

// Deleting a home removes test clutter. It is for super admins only, and only for a home that never
// went live: a hub that connected, or any support history, keeps the home (and its audit trail).

let c: TestCloud;
let admin: TestStaff;
beforeAll(async () => {
  c = await startCloud();
  admin = await c.addStaff('PLATFORM_SUPER_ADMIN');
});
afterAll(() => c.close());

describe('delete a home', () => {
  it('removes an unused home, its never-connected hub and its assignments, and records it in the audit log', async () => {
    const support = await c.addStaff('PLATFORM_SUPPORT');
    const home = await c.addHome('Duplicate');
    await c.assign(support.staffId, home);
    expect((await c.req('POST', `/api/v1/homes/${home}/hub`, { cookie: admin.cookie, body: { hubId: 'unused-hub' } })).status).toBe(201);

    expect((await c.req('DELETE', `/api/v1/homes/${home}`, { cookie: admin.cookie })).status).toBe(204);
    expect((await c.req('GET', `/api/v1/homes/${home}`, { cookie: admin.cookie })).status).toBe(404);
    expect((await c.req('GET', '/api/v1/homes', { cookie: admin.cookie })).body.some((h: { homeId: string }) => h.homeId === home)).toBe(false);
    // The hub id is free again.
    const again = await c.addHome('Real home');
    expect((await c.req('POST', `/api/v1/homes/${again}/hub`, { cookie: admin.cookie, body: { hubId: 'unused-hub' } })).status).toBe(201);

    const audit = (await c.req('GET', `/api/v1/audit?homeId=${home}`, { cookie: admin.cookie })).body;
    expect(JSON.stringify(audit)).toContain('home.delete');
  });

  it('only a super admin may delete, and a missing home is 404', async () => {
    const home = await c.addHome('Protected');
    for (const role of ['PLATFORM_SUPPORT', 'INSTALLER'] as const) {
      const s = await c.addStaff(role);
      await c.assign(s.staffId, home);
      expect((await c.req('DELETE', `/api/v1/homes/${home}`, { cookie: s.cookie })).status, role).toBe(403);
    }
    expect((await c.req('GET', `/api/v1/homes/${home}`, { cookie: admin.cookie })).status).toBe(200);
    expect((await c.req('DELETE', '/api/v1/homes/00000000-0000-4000-8000-000000000000', { cookie: admin.cookie })).status).toBe(404);
  });

  it('refuses a home whose hub has connected, and a home with support history', async () => {
    const live = await c.addHome('Live');
    await c.addHub(live, 'live-hub');
    const res = await c.req('DELETE', `/api/v1/homes/${live}`, { cookie: admin.cookie });
    expect(res.status).toBe(409);
    expect((await c.req('GET', `/api/v1/homes/${live}`, { cookie: admin.cookie })).status).toBe(200);

    const support = await c.staff.create({ email: 'hist@voltex.test', displayName: 'Hist', role: 'PLATFORM_SUPPORT' }, 'cli');
    const withHistory = await c.addHome('History');
    await c.addHub(withHistory, 'history-hub');
    await c.assign(support.staff!.staffId, withHistory);
    await c.activeGrant(withHistory, { staffId: support.staff!.staffId, role: 'PLATFORM_SUPPORT' });
    expect((await c.req('DELETE', `/api/v1/homes/${withHistory}`, { cookie: admin.cookie })).status).toBe(409);
  });
});
