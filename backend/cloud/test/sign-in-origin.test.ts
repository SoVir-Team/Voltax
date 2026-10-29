import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, startCloud, type TestCloud } from './helpers.js';

// Local launcher only: one sign-in page (the home app) for homeowners and staff. The browser sends
// a staff password from that page straight to the cloud's login, never through the hub. Only the
// configured page, and only the login route, may do this cross-origin.

const PORTAL = 'http://localhost:8098';
const SIGN_IN_PAGE = 'http://localhost:8088';
let c: TestCloud;
beforeAll(async () => {
  c = await startCloud({ api: { publicOrigin: PORTAL, signInOrigins: [SIGN_IN_PAGE] } });
});
afterAll(() => c.close());

describe('staff sign-in from the shared sign-in page', () => {
  it('answers the browser preflight for the configured page only', async () => {
    const ok = await c.req('OPTIONS', '/api/v1/auth/login', { headers: { origin: SIGN_IN_PAGE, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
    expect(ok.status).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe(SIGN_IN_PAGE);
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    expect(String(ok.headers['access-control-allow-headers'])).toContain('content-type');

    const other = await c.req('OPTIONS', '/api/v1/auth/login', { headers: { origin: 'http://localhost:9999', 'access-control-request-method': 'POST' } });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('signs staff in from that page and sets the portal session', async () => {
    const s = await c.addStaff('PLATFORM_SUPER_ADMIN', 'shared-page-admin');
    const res = await c.req('POST', '/api/v1/auth/login', { headers: { origin: SIGN_IN_PAGE }, body: { email: s.email, password: PASSWORD } });
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(SIGN_IN_PAGE);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    const cookie = String(res.headers['set-cookie']).split(';')[0]!;
    expect((await c.req('GET', '/api/v1/auth/me', { cookie })).status).toBe(200);
  });

  it('a wrong password is still refused, and any other origin or route stays blocked', async () => {
    const s = await c.addStaff('PLATFORM_SUPPORT', 'shared-page-support');
    expect((await c.req('POST', '/api/v1/auth/login', { headers: { origin: SIGN_IN_PAGE }, body: { email: s.email, password: 'not the password!' } })).status).toBe(401);
    expect((await c.req('POST', '/api/v1/auth/login', { headers: { origin: 'http://localhost:9999' }, body: { email: s.email, password: PASSWORD } })).status).toBe(403);

    const login = await c.req('POST', '/api/v1/auth/login', { body: { email: s.email, password: PASSWORD } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const other = await c.req('POST', '/api/v1/auth/logout', { cookie, headers: { origin: SIGN_IN_PAGE } });
    expect(other.status).toBe(403);
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('is off unless configured', async () => {
    const plain = await startCloud({ api: { publicOrigin: PORTAL } });
    try {
      const s = await plain.addStaff('PLATFORM_SUPER_ADMIN', 'no-shared-page');
      const res = await plain.req('POST', '/api/v1/auth/login', { headers: { origin: SIGN_IN_PAGE }, body: { email: s.email, password: PASSWORD } });
      expect(res.status).toBe(403);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await plain.close();
    }
  });
});
