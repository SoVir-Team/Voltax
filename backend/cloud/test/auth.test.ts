import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_FAILED_LOGINS } from '../src/staff.js';
import { PASSWORD, startCloud, type TestCloud } from './helpers.js';

let c: TestCloud;
beforeAll(async () => {
  c = await startCloud();
});
afterAll(async () => {
  await c.close();
});

describe('staff authentication', () => {
  it('a setup link is single-use, and a setup-only session can do nothing but enrol two-factor', async () => {
    const { setupToken } = await c.staff.create({ email: 'new.person@voltex.test', displayName: 'New Person', role: 'PLATFORM_SUPPORT' }, 'cli');
    const first = await c.req('POST', '/api/v1/auth/setup', { body: { token: setupToken, password: PASSWORD } });
    expect(first.status).toBe(200);
    const replay = await c.req('POST', '/api/v1/auth/setup', { body: { token: setupToken, password: 'another long password' } });
    expect(replay.status).toBe(400);

    const cookie = String(first.headers['set-cookie']).split(';')[0]!;
    expect(String(first.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Strict/);
    expect((await c.req('GET', '/api/v1/auth/me', { cookie })).body.mfa).toBe(false);
    const blocked = await c.req('GET', '/api/v1/homes', { cookie });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('mfa_required');
    expect((await c.req('POST', '/api/v1/auth/password', { cookie, body: { current: PASSWORD, next: 'something else long' } })).status).toBe(403);
  });

  it('weak passwords are refused at setup', async () => {
    const { setupToken } = await c.staff.create({ email: 'weak@voltex.test', displayName: 'Weak', role: 'INSTALLER' }, 'cli');
    expect((await c.req('POST', '/api/v1/auth/setup', { body: { token: setupToken, password: 'short' } })).status).toBe(400);
  });

  it('a password alone never signs in: no session before two-factor enrolment, and the code is required after', async () => {
    const { staff, setupToken } = await c.staff.create({ email: 'nomfa@voltex.test', displayName: 'No MFA', role: 'INSTALLER' }, 'cli');
    await c.req('POST', '/api/v1/auth/setup', { body: { token: setupToken, password: PASSWORD } });
    const before = await c.req('POST', '/api/v1/auth/login', { body: { email: staff.email, password: PASSWORD } });
    expect(before.status).toBe(403);
    expect(before.headers['set-cookie']).toBeUndefined();

    const s = await c.addStaff('INSTALLER');
    const noCode = await c.req('POST', '/api/v1/auth/login', { body: { email: s.email, password: PASSWORD } });
    expect(noCode.status).toBe(401);
    expect(noCode.headers['set-cookie']).toBeUndefined();
  });

  it('a TOTP code is accepted once; replaying it fails', async () => {
    const s = await c.addStaff('PLATFORM_SUPPORT');
    const code = await c.nextCode(s.staffId, s.secret);
    expect((await c.req('POST', '/api/v1/auth/login', { body: { email: s.email, password: PASSWORD, code } })).status).toBe(200);
    expect((await c.req('POST', '/api/v1/auth/login', { body: { email: s.email, password: PASSWORD, code } })).status).toBe(401);
  });

  it('locks the account after repeated failures, even for the right password', async () => {
    const s = await c.addStaff('PLATFORM_SUPPORT');
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) {
      await c.req('POST', '/api/v1/auth/login', { body: { email: s.email, password: 'wrong password!!', code: '000000' }, headers: { 'x-test': String(i) } });
    }
    const locked = await c.req('POST', '/api/v1/auth/login', { body: { email: s.email, password: PASSWORD, code: await c.nextCode(s.staffId, s.secret) } });
    expect(locked.status).toBe(429);
  });

  it('unknown accounts and wrong passwords get the same answer', async () => {
    const s = await c.addStaff('INSTALLER');
    const unknown = await c.req('POST', '/api/v1/auth/login', { body: { email: 'nobody@voltex.test', password: PASSWORD, code: '123456' } });
    const wrong = await c.req('POST', '/api/v1/auth/login', { body: { email: s.email, password: 'not the password', code: '123456' } });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });

  it('logout ends the session; replaying the old cookie is refused', async () => {
    const s = await c.addStaff('PLATFORM_SUPPORT');
    expect((await c.req('GET', '/api/v1/homes', { cookie: s.cookie })).status).toBe(200);
    expect((await c.req('POST', '/api/v1/auth/logout', { cookie: s.cookie })).status).toBe(200);
    expect((await c.req('GET', '/api/v1/homes', { cookie: s.cookie })).status).toBe(401);
    expect((await c.req('GET', '/api/v1/auth/me', { cookie: s.cookie })).status).toBe(401);
  });

  it('expired and idle sessions are refused', async () => {
    const a = await c.addStaff('PLATFORM_SUPPORT');
    await c.db.query('UPDATE sessions SET expires_at = $2 WHERE staff_id = $1', [a.staffId, Date.now() - 1]);
    expect((await c.req('GET', '/api/v1/homes', { cookie: a.cookie })).status).toBe(401);
    const b = await c.addStaff('PLATFORM_SUPPORT');
    await c.db.query('UPDATE sessions SET last_seen_at = $2 WHERE staff_id = $1', [b.staffId, Date.now() - 2 * 60 * 60_000]);
    expect((await c.req('GET', '/api/v1/homes', { cookie: b.cookie })).status).toBe(401);
  });

  it('disabling staff kills their open sessions immediately', async () => {
    const admin = await c.addStaff('PLATFORM_SUPER_ADMIN');
    const s = await c.addStaff('PLATFORM_SUPPORT');
    expect((await c.req('GET', '/api/v1/homes', { cookie: s.cookie })).status).toBe(200);
    expect((await c.req('PATCH', `/api/v1/staff/${s.staffId}`, { cookie: admin.cookie, body: { disabled: true } })).status).toBe(200);
    expect((await c.req('GET', '/api/v1/homes', { cookie: s.cookie })).status).toBe(401);
    const login = await c.req('POST', '/api/v1/auth/login', { body: { email: s.email, password: PASSWORD, code: await c.nextCode(s.staffId, s.secret) } });
    expect(login.status).toBe(401);
  });

  it('a role change applies on the very next request (role is never cached in the session)', async () => {
    const admin = await c.addStaff('PLATFORM_SUPER_ADMIN');
    const other = await c.addStaff('PLATFORM_SUPER_ADMIN');
    expect((await c.req('GET', '/api/v1/staff', { cookie: other.cookie })).status).toBe(200);
    expect((await c.req('PATCH', `/api/v1/staff/${other.staffId}`, { cookie: admin.cookie, body: { role: 'PLATFORM_SUPPORT' } })).status).toBe(200);
    expect((await c.req('GET', '/api/v1/staff', { cookie: other.cookie })).status).toBe(403);
  });

  it('staff cannot change their own role or disable themselves; the last super admin cannot be removed', async () => {
    const admin = await c.addStaff('PLATFORM_SUPER_ADMIN');
    expect((await c.req('PATCH', `/api/v1/staff/${admin.staffId}`, { cookie: admin.cookie, body: { disabled: true } })).status).toBe(403);
    expect((await c.req('PATCH', `/api/v1/staff/${admin.staffId}`, { cookie: admin.cookie, body: { role: 'INSTALLER' } })).status).toBe(403);
    // Disable every other admin, then try to remove the last one through a fresh admin's eyes.
    const admins = (await c.staff.list()).filter((s) => s.role === 'PLATFORM_SUPER_ADMIN' && !s.disabled && s.staffId !== admin.staffId);
    for (const a of admins) await c.staff.update(a.staffId, { disabled: true }, admin.staffId);
    const [{ n }] = (await c.db.query<{ n: number }>("SELECT count(*)::int AS n FROM staff WHERE role = 'PLATFORM_SUPER_ADMIN' AND disabled_at IS NULL")) as [
      { n: number },
    ];
    expect(n).toBe(1);
    await expect(c.staff.update(admin.staffId, { disabled: true }, 'someone-else')).rejects.toThrow(/last super admin/);
    for (const a of admins) await c.staff.update(a.staffId, { disabled: false }, admin.staffId);
  });

  it('bootstrap-admin is refused once a super admin exists (no backdoor)', async () => {
    await c.addStaff('PLATFORM_SUPER_ADMIN');
    await expect(c.staff.bootstrapAdmin('second@voltex.test', 'Second')).rejects.toThrow(/already exists/);
  });

  it('credential reset ends sessions and requires a new setup link', async () => {
    const admin = await c.addStaff('PLATFORM_SUPER_ADMIN');
    const s = await c.addStaff('INSTALLER');
    const reset = await c.req('POST', `/api/v1/staff/${s.staffId}/reset`, { cookie: admin.cookie });
    expect(reset.status).toBe(200);
    expect(typeof reset.body.setupToken).toBe('string');
    expect((await c.req('GET', '/api/v1/homes', { cookie: s.cookie })).status).toBe(401);
    expect((await c.req('POST', '/api/v1/auth/login', { body: { email: s.email, password: PASSWORD, code: '123456' } })).status).toBe(401);
    expect((await c.req('POST', '/api/v1/auth/setup', { body: { token: reset.body.setupToken, password: PASSWORD } })).status).toBe(200);
  });

  it('refuses cross-origin state changes and non-JSON bodies', async () => {
    const admin = await c.addStaff('PLATFORM_SUPER_ADMIN');
    const evil = await c.req('POST', '/api/v1/homes', { cookie: admin.cookie, body: { name: 'x' }, headers: { origin: 'https://evil.example', host: 'portal.voltex.test' } });
    expect(evil.status).toBe(403);
    const form = await c.app.inject({ method: 'POST', url: '/api/v1/homes', headers: { cookie: admin.cookie, 'content-type': 'text/plain' }, payload: '{"name":"x"}' });
    expect(form.statusCode).toBe(415);
  });

  it('never stores passwords, codes, setup tokens or session tokens in the audit log', async () => {
    const s = await c.addStaff('PLATFORM_SUPPORT');
    const token = s.cookie.split('=')[1]!;
    const rows = await c.db.query<{ details: string; target: string | null; actor: string }>('SELECT details, target, actor FROM audit_log');
    const all = JSON.stringify(rows);
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain(token);
    expect(all).not.toContain(s.secret);
  });

  it('rate-limits login attempts per client address (production default: 10 a minute)', async () => {
    const limited = await startCloud({ api: { loginLimitPerMinute: undefined } });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) {
        statuses.push((await limited.req('POST', '/api/v1/auth/login', { body: { email: 'x@voltex.test', password: 'whatever', code: '123456' } })).status);
      }
      expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
      expect(statuses.slice(10)).toEqual([429, 429]);
    } finally {
      await limited.close();
    }
  });

  it('security headers are set and API responses are not cached', async () => {
    const res = await c.req('GET', '/api/v1/health');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('retention: ended sessions and used or expired setup links are deleted; live ones stay', async () => {
    const live = await c.addStaff('INSTALLER');
    const gone = await c.addStaff('INSTALLER');
    await c.req('POST', '/api/v1/auth/logout', { cookie: gone.cookie });
    const { setupToken } = await c.staff.create({ email: 'pending.setup@voltex.test', displayName: 'Pending', role: 'INSTALLER' }, 'cli');
    const count = async (sql: string) => Number((await c.db.query<{ n: number }>(sql))[0]!.n);
    const usedOrOld = "SELECT count(*)::int AS n FROM staff_setup_tokens WHERE used_at IS NOT NULL OR expires_at <= (extract(epoch from now()) * 1000)::bigint";
    expect(await count(usedOrOld)).toBeGreaterThan(0); // every addStaff used a setup link

    const removed = await c.staff.purgeExpired();
    expect(removed.sessions).toBeGreaterThan(0);
    expect(await count(usedOrOld)).toBe(0);
    expect(await count('SELECT count(*)::int AS n FROM sessions WHERE revoked_at IS NOT NULL')).toBe(0);
    expect((await c.req('GET', '/api/v1/auth/me', { cookie: live.cookie })).status).toBe(200);
    expect((await c.req('POST', '/api/v1/auth/setup', { body: { token: setupToken, password: PASSWORD } })).status).toBe(200);

    // Sessions past their idle or absolute limit go too.
    await c.db.query('UPDATE sessions SET last_seen_at = 0');
    await c.staff.purgeExpired();
    expect(await count('SELECT count(*)::int AS n FROM sessions')).toBe(0);
  });
});
