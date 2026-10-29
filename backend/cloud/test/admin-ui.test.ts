import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCloud, type TestCloud } from './helpers.js';

// The company portal (frontend/admin static export) is served by the cloud on the API's origin.
let c: TestCloud;
let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'voltex-admin-ui-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>VOLTEX Admin</title>');
  mkdirSync(join(dir, 'staff'));
  writeFileSync(join(dir, 'staff', 'index.html'), '<!doctype html><title>Staff</title>');
  c = await startCloud({ api: { uiDir: dir } });
});
afterAll(async () => {
  await c.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('admin portal files', () => {
  it('serves pages with a strict content security policy', async () => {
    const res = await c.req('GET', '/staff/');
    expect(res.status).toBe(200);
    expect(String(res.body)).toContain('<title>Staff</title>');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('redirects a page without its trailing slash', async () => {
    const res = await c.req('GET', '/staff');
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('/staff/');
  });

  it('keeps the API deny-by-default: unknown API paths are JSON 404s, never a page', async () => {
    const res = await c.req('GET', '/api/v1/nothing-here');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found', message: 'not found' });
    expect((await c.req('GET', '/api/v1/staff')).status).toBe(401);
  });

  it('does not serve files outside the portal folder', async () => {
    expect((await c.req('GET', '/..%2fpackage.json')).status).toBe(404);
    expect((await c.req('GET', '/missing/')).status).toBe(404);
  });
});
