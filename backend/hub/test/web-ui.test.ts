import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startEnv, type TestEnv } from './helpers.js';

// The hub serves the customer web app (frontend/web static export). Owners approve support access
// there, so no other site may frame it (clickjacking) or inject script into it.
let env: TestEnv;
let ui: string;
beforeAll(async () => {
  ui = mkdtempSync(join(tmpdir(), 'voltex-web-ui-'));
  writeFileSync(join(ui, 'index.html'), '<!doctype html><title>VOLTEX</title>');
  mkdirSync(join(ui, 'access'));
  writeFileSync(join(ui, 'access', 'index.html'), '<!doctype html><title>Access</title>');
  env = await startEnv({ connectDevice: false, uiDir: ui });
});
afterAll(async () => {
  await env.close();
  rmSync(ui, { recursive: true, force: true });
});

describe('web app security headers', () => {
  it('serves pages that cannot be framed, with a strict content security policy', async () => {
    const res = await env.hub.app.inject({ method: 'GET', url: '/access/', headers: { host: 'voltax-hub.local:8443' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<title>Access</title>');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    // The live WebSocket goes back to the hub itself, and nowhere else.
    expect(csp).toContain("connect-src 'self' wss://voltax-hub.local:8443 ws://voltax-hub.local:8443");
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('never reflects a malformed Host header into the policy', async () => {
    const res = await env.hub.app.inject({ method: 'GET', url: '/', headers: { host: "evil.example' 'unsafe-eval" } });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).not.toContain('evil');
    expect(csp).toContain("connect-src 'self';");
  });

  it('API responses are not cacheable and not sniffable', async () => {
    const res = await env.hub.app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeUndefined();
  });
});
