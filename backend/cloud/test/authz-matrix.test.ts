import { randomUUID } from 'node:crypto';
import { PLATFORM_ROLES, platformScope, type PlatformAction, type PlatformRole } from '@voltax/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CloudGuard } from '../src/guard.js';
import { hubRelease, PASSWORD, startCloud, type TestCloud, type TestStaff } from './helpers.js';

// Every guarded route x every platform role x (assigned home, unassigned home), with the expected
// outcome derived from shared/contracts permissions.ts. A new route without an entry here fails.

let c: TestCloud;
let homeA: string; // assigned to the support and installer accounts
let homeB: string; // assigned to nobody under test
const staffByRole = {} as Record<PlatformRole, TestStaff>;

type Build = (homeId: string, staff: TestStaff) => Promise<{ url: string; body?: unknown }>;
const grantUrl = async (h: string, staff: TestStaff, suffix = '') => `/api/v1/homes/${h}/grants/${await c.activeGrant(h, staff)}${suffix}`;

const freshStaff = async (role: PlatformRole = 'INSTALLER') =>
  (await c.staff.create({ email: `t-${randomUUID().slice(0, 8)}@voltex.test`, displayName: 'Target', role }, 'cli')).staff.staffId;

// Fleet fixtures, created directly by the super admin so every role sees the same objects.
let releaseN = 0;
const sa = () => staffByRole.PLATFORM_SUPER_ADMIN.staffId;
const freshRelease = async () => (await c.fleet.registerRelease(hubRelease(`3.0.${releaseN++}`), sa())).releaseId;
const noActiveRollout = () => c.db.query("UPDATE rollouts SET status = 'cancelled' WHERE status IN ('running', 'halted')");
const freshRollout = async (halted = false) => {
  await noActiveRollout();
  const r = await c.fleet.createRollout({ releaseId: await freshRelease(), stages: [10, 50, 100], maxFailureRate: 0.1, healthWindowMinutes: 60 }, sa());
  if (halted) await c.fleet.halt(r.rolloutId, 'matrix test', 'system');
  return r.rolloutId;
};

const ROUTES: Record<string, Build> = {
  'GET /api/v1/staff': async () => ({ url: '/api/v1/staff' }),
  'POST /api/v1/staff': async () => ({ url: '/api/v1/staff', body: { email: `n-${randomUUID().slice(0, 8)}@voltex.test`, displayName: 'New', role: 'INSTALLER' } }),
  'GET /api/v1/staff/:staffId': async () => ({ url: `/api/v1/staff/${await freshStaff()}` }),
  'PATCH /api/v1/staff/:staffId': async () => ({ url: `/api/v1/staff/${await freshStaff()}`, body: { displayName: 'Renamed' } }),
  'POST /api/v1/staff/:staffId/reset': async () => ({ url: `/api/v1/staff/${await freshStaff()}/reset` }),
  'GET /api/v1/assignments': async () => ({ url: '/api/v1/assignments' }),
  'POST /api/v1/assignments': async () => ({ url: '/api/v1/assignments', body: { staffId: await freshStaff(), homeId: homeA } }),
  'DELETE /api/v1/assignments/:assignmentId': async () => ({ url: `/api/v1/assignments/${await c.assign(await freshStaff(), homeA)}` }),
  'GET /api/v1/homes': async () => ({ url: '/api/v1/homes' }),
  'POST /api/v1/homes': async () => ({ url: '/api/v1/homes', body: { name: 'Another home' } }),
  'GET /api/v1/homes/:homeId': async (h) => ({ url: `/api/v1/homes/${h}` }),
  'PATCH /api/v1/homes/:homeId': async (h) => ({ url: `/api/v1/homes/${h}`, body: { name: 'Renamed home' } }),
  'GET /api/v1/homes/:homeId/contact': async (h) => ({ url: `/api/v1/homes/${h}/contact` }),
  'GET /api/v1/homes/:homeId/hub': async (h) => ({ url: `/api/v1/homes/${h}/hub` }),
  'POST /api/v1/homes/:homeId/hub': async (h) => ({ url: `/api/v1/homes/${h}/hub`, body: { hubId: (await c.homes.hubOf(h))! } }),
  'GET /api/v1/homes/:homeId/devices': async (h) => ({ url: `/api/v1/homes/${h}/devices` }),
  'GET /api/v1/audit': async () => ({ url: '/api/v1/audit' }),
  'POST /api/v1/audit/verify': async () => ({ url: '/api/v1/audit/verify' }),
  'GET /api/v1/audit/checkpoints': async () => ({ url: '/api/v1/audit/checkpoints' }),
  'GET /api/v1/homes/:homeId/hub/audit': async (h) => ({ url: `/api/v1/homes/${h}/hub/audit` }),
  'GET /api/v1/grants': async () => ({ url: '/api/v1/grants' }),
  'POST /api/v1/homes/:homeId/grants': async (h, s) => {
    await c.db.query("UPDATE grants SET status = 'revoked' WHERE home_id = $1 AND staff_id = $2 AND status IN ('pending', 'active')", [h, s.staffId]);
    return { url: `/api/v1/homes/${h}/grants`, body: { deviceIds: ['kitchen'], actions: ['diagnostics.read'], reason: 'customer reported the hub is slow', durationMinutes: 30 } };
  },
  'GET /api/v1/homes/:homeId/grants': async (h) => ({ url: `/api/v1/homes/${h}/grants` }),
  'GET /api/v1/homes/:homeId/grants/:grantId': async (h, s) => ({ url: await grantUrl(h, s) }),
  'GET /api/v1/homes/:homeId/grants/:grantId/notifications': async (h, s) => ({ url: await grantUrl(h, s, '/notifications') }),
  'POST /api/v1/homes/:homeId/grants/:grantId/revoke': async (h, s) => ({ url: await grantUrl(h, s, '/revoke'), body: { reason: 'work finished' } }),
  'POST /api/v1/homes/:homeId/grants/:grantId/commands': async (h, s) => ({ url: await grantUrl(h, s, '/commands'), body: { entityId: 'kitchen.switch.relay', value: true } }),
  'GET /api/v1/homes/:homeId/grants/:grantId/commands': async (h, s) => ({ url: await grantUrl(h, s, '/commands') }),
  'POST /api/v1/homes/:homeId/grants/:grantId/diagnostics': async (h, s) => ({ url: await grantUrl(h, s, '/diagnostics') }),
  'POST /api/v1/homes/:homeId/grants/:grantId/activity': async (h, s) => ({ url: await grantUrl(h, s, '/activity'), body: { sinceMinutes: 60 } }),
  'POST /api/v1/homes/:homeId/grants/:grantId/restart': async (h, s) => ({ url: await grantUrl(h, s, '/restart') }),
  'GET /api/v1/fleet/summary': async () => ({ url: '/api/v1/fleet/summary' }),
  'GET /api/v1/releases': async () => ({ url: '/api/v1/releases' }),
  'POST /api/v1/releases': async () => ({ url: '/api/v1/releases', body: hubRelease(`3.0.${releaseN++}`) }),
  'GET /api/v1/releases/:releaseId': async () => ({ url: `/api/v1/releases/${await freshRelease()}` }),
  'GET /api/v1/releases/:releaseId/compatibility': async () => ({ url: `/api/v1/releases/${await freshRelease()}/compatibility` }),
  'POST /api/v1/releases/:releaseId/withdraw': async () => ({ url: `/api/v1/releases/${await freshRelease()}/withdraw`, body: { reason: 'bad build' } }),
  'GET /api/v1/rollouts': async () => ({ url: '/api/v1/rollouts' }),
  'POST /api/v1/rollouts': async () => {
    await noActiveRollout();
    return { url: '/api/v1/rollouts', body: { releaseId: await freshRelease() } };
  },
  'GET /api/v1/rollouts/:rolloutId': async () => ({ url: `/api/v1/rollouts/${await freshRollout()}` }),
  'POST /api/v1/rollouts/:rolloutId/halt': async () => ({ url: `/api/v1/rollouts/${await freshRollout()}/halt`, body: { reason: 'matrix test' } }),
  'POST /api/v1/rollouts/:rolloutId/resume': async () => ({ url: `/api/v1/rollouts/${await freshRollout(true)}/resume`, body: { reason: 'matrix test' } }),
  'POST /api/v1/rollouts/:rolloutId/cancel': async () => ({ url: `/api/v1/rollouts/${await freshRollout()}/cancel`, body: { reason: 'matrix test' } }),
};

beforeAll(async () => {
  c = await startCloud();
  homeA = await c.addHome('Assigned home');
  homeB = await c.addHome('Other home');
  await c.addHub(homeA, 'hub-assigned');
  await c.addHub(homeB, 'hub-other');
  for (const role of PLATFORM_ROLES) staffByRole[role] = await c.addStaff(role);
  await c.assign(staffByRole.PLATFORM_SUPPORT.staffId, homeA);
  await c.assign(staffByRole.INSTALLER.staffId, homeA);
});
afterAll(async () => {
  await c.close();
});

const actionRoutes = () =>
  c.app.routeGuards.filter((r): r is { method: string; url: string; guard: Extract<CloudGuard, { action: PlatformAction }> } => 'action' in r.guard);

describe('permission matrix: coverage', () => {
  it('every action-guarded route has a matrix entry (new routes must be added here)', () => {
    const registered = actionRoutes().map((r) => `${r.method} ${r.url}`);
    expect(registered.length).toBeGreaterThan(0);
    for (const key of registered) expect(Object.keys(ROUTES), `missing matrix entry for ${key}`).toContain(key);
  });

  it('every non-public route refuses requests without a session (401)', async () => {
    for (const r of c.app.routeGuards.filter((g) => !('public' in g.guard))) {
      const url = r.url.replace(':homeId', homeA).replace(/:\w+/g, randomUUID());
      const res = await c.req(r.method, url, { body: r.method === 'GET' || r.method === 'DELETE' ? undefined : {} });
      expect(res.status, `${r.method} ${r.url}`).toBe(401);
    }
  });

  it('a forged or random session cookie is refused (401)', async () => {
    for (const cookie of ['voltax_session=forged', `voltax_session=${'A'.repeat(43)}`, 'voltax_session=' + 'x'.repeat(500)]) {
      expect((await c.req('GET', '/api/v1/homes', { cookie })).status).toBe(401);
    }
  });
});

describe.each(PLATFORM_ROLES)('permission matrix: %s', (role) => {
  for (const [key, build] of Object.entries(ROUTES)) {
    const [method, path] = key.split(' ') as [string, string];
    const homeRoute = path.includes(':homeId');
    const targets = homeRoute ? (['assigned', 'unassigned'] as const) : (['n/a'] as const);
    for (const target of targets) {
      it(`${key} ${homeRoute ? `(${target} home)` : ''}`, async () => {
        const guard = c.app.routeGuards.find((r) => `${r.method} ${r.url}` === key)!.guard as { action: PlatformAction };
        const scope = platformScope(role, guard.action);
        const homeId = target === 'unassigned' ? homeB : homeA;
        const req = await build(homeId, staffByRole[role]);
        const res = await c.req(method, req.url, { cookie: staffByRole[role].cookie, body: req.body });

        if (!scope) expect(res.status, JSON.stringify(res.body)).toBe(403);
        else if ((scope === 'assigned' || scope === 'grant') && target === 'unassigned') expect(res.status).toBe(404);
        else expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(200);
        if (scope && !((scope === 'assigned' || scope === 'grant') && target === 'unassigned')) expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      });
    }
  }
});

describe('manipulated identifiers and cross-home isolation', () => {
  it('home ids that are random, malformed or injection attempts are 404 for every role', async () => {
    for (const role of PLATFORM_ROLES) {
      for (const id of [randomUUID(), 'not-a-uuid', "1' OR '1'='1", '../staff', '%00']) {
        const res = await c.req('GET', `/api/v1/homes/${encodeURIComponent(id)}`, { cookie: staffByRole[role].cookie });
        expect(res.status, `${role} ${id}`).toBe(404);
      }
    }
  });

  it('home id in the URL decides the scope: a home id in the body cannot widen it', async () => {
    const res = await c.req('POST', `/api/v1/homes/${homeB}/hub`, { cookie: staffByRole.INSTALLER.cookie, body: { homeId: homeA, hubId: 'hub-other' } });
    expect(res.status).toBe(404);
    const viaQuery = await c.req('GET', `/api/v1/homes/${homeB}/devices?homeId=${homeA}`, { cookie: staffByRole.INSTALLER.cookie });
    expect(viaQuery.status).toBe(404);
  });

  it('assigned staff list only their homes; the super admin lists all', async () => {
    const support = (await c.req('GET', '/api/v1/homes', { cookie: staffByRole.PLATFORM_SUPPORT.cookie })).body as Array<{ homeId: string }>;
    expect(support.map((h) => h.homeId)).toEqual([homeA]);
    const admin = (await c.req('GET', '/api/v1/homes', { cookie: staffByRole.PLATFORM_SUPER_ADMIN.cookie })).body as Array<{ homeId: string }>;
    expect(admin.map((h) => h.homeId)).toEqual(expect.arrayContaining([homeA, homeB]));
  });

  it('home details never include the owner contact; that needs home.contact.read and is audited', async () => {
    const home = (await c.req('GET', `/api/v1/homes/${homeA}`, { cookie: staffByRole.PLATFORM_SUPER_ADMIN.cookie })).body;
    expect(JSON.stringify(home)).not.toContain('owner@example.test');
    expect((await c.req('GET', `/api/v1/homes/${homeA}/contact`, { cookie: staffByRole.PLATFORM_SUPER_ADMIN.cookie })).status).toBe(403);
    expect((await c.req('GET', `/api/v1/homes/${homeA}/contact`, { cookie: staffByRole.PLATFORM_SUPPORT.cookie })).body.ownerContact).toBe('owner@example.test');
    const audit = await c.audit.list({ homeId: homeA, limit: 500 });
    expect(audit.some((r) => r.action === 'home.contact.read' && r.actor === `staff:${staffByRole.PLATFORM_SUPPORT.staffId}`)).toBe(true);
  });

  it('denied attempts are audited with the role and the reason', async () => {
    await c.req('GET', `/api/v1/homes/${homeB}`, { cookie: staffByRole.INSTALLER.cookie });
    await c.req('GET', '/api/v1/staff', { cookie: staffByRole.INSTALLER.cookie });
    const denied = (await c.audit.list({ limit: 500, afterSeq: 0 })).filter(
      (r) => r.action === 'authz.denied' && r.actor === `staff:${staffByRole.INSTALLER.staffId}`,
    );
    expect(denied.some((r) => r.homeId === homeB && r.details.reason === 'not assigned to this home')).toBe(true);
    expect(denied.some((r) => r.details.reason === 'INSTALLER may not staff.read')).toBe(true);
  });

  it('a setup-only session (no two-factor yet) is refused on every action route', async () => {
    const { setupToken } = await c.staff.create({ email: `half-${randomUUID().slice(0, 6)}@voltex.test`, displayName: 'Half', role: 'PLATFORM_SUPER_ADMIN' }, 'cli');
    const setup = await c.req('POST', '/api/v1/auth/setup', { body: { token: setupToken, password: PASSWORD } });
    const cookie = String(setup.headers['set-cookie']).split(';')[0]!;
    for (const r of actionRoutes()) {
      const res = await c.req(r.method, r.url.replace(/:\w+/g, homeA), { cookie, body: r.method === 'GET' || r.method === 'DELETE' ? undefined : {} });
      expect(res.status, `${r.method} ${r.url}`).toBe(403);
    }
  });
});
