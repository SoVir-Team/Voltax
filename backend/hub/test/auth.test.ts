import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { pairOwner, startEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(async () => {
  env = await startEnv({ connectDevice: false });
});
afterEach(async () => env.close());

const pair = (pairingCode: string, ip = '10.0.0.5') =>
  env.hub.app.inject({ method: 'POST', url: '/api/v1/pair', remoteAddress: ip, payload: { pairingCode, clientName: 'phone' } });

describe('pairing', () => {
  it('generates unpredictable 10-character codes', () => {
    const a = env.hub.auth.createPairingCode('owner').code;
    const b = env.hub.auth.createPairingCode('owner').code;
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(a).not.toBe(b);
  });

  it('pairs once with a valid code and issues a working token', async () => {
    const { code } = env.hub.auth.createPairingCode('owner');
    const res = await pair(code);
    expect(res.statusCode).toBe(201);
    const { token, role } = res.json<{ token: string; role: string }>();
    expect(role).toBe('owner');
    const devices = await env.hub.app.inject({ method: 'GET', url: '/api/v1/devices', headers: { authorization: `Bearer ${token}` } });
    expect(devices.statusCode).toBe(200);
  });

  it('accepts codes typed with dashes or lower case', async () => {
    const { code } = env.hub.auth.createPairingCode('owner');
    expect((await pair(`${code.slice(0, 5).toLowerCase()}-${code.slice(5)}`)).statusCode).toBe(201);
  });

  it('is single-use', async () => {
    const { code } = env.hub.auth.createPairingCode('owner');
    expect((await pair(code)).statusCode).toBe(201);
    expect((await pair(code)).statusCode).toBe(401);
  });

  it('rejects expired codes', async () => {
    const { code } = env.hub.auth.createPairingCode('owner', -1);
    expect((await pair(code)).statusCode).toBe(401);
  });

  it('stores only hashes, never the code or token', async () => {
    const { code } = env.hub.auth.createPairingCode('owner');
    const { token } = (await pair(code)).json<{ token: string }>();
    const dump = JSON.stringify([
      env.hub.db.prepare('SELECT * FROM pairing_codes').all(),
      env.hub.db.prepare('SELECT * FROM clients').all(),
    ]);
    expect(dump).not.toContain(code);
    expect(dump).not.toContain(token);
  });

  it('rate-limits an IP after 5 failures (429)', async () => {
    env.hub.auth.createPairingCode('owner');
    for (let i = 0; i < 5; i++) expect((await pair('WRONGCODE1', '10.0.0.9')).statusCode).toBe(401);
    expect((await pair('WRONGCODE1', '10.0.0.9')).statusCode).toBe(429);
  });

  it('closes the pairing window after 10 failures across IPs', async () => {
    const { code } = env.hub.auth.createPairingCode('owner');
    for (let i = 0; i < 10; i++) await pair('WRONGCODE1', `10.0.1.${i}`);
    // The genuine code no longer works: a new deliberate action is required.
    expect((await pair(code, '10.0.2.1')).statusCode).toBe(401);
    const fresh = env.hub.auth.createPairingCode('owner').code;
    expect((await pair(fresh, '10.0.2.2')).statusCode).toBe(201);
  });
});

describe('roles and revocation', () => {
  it('lets an owner invite a member; members cannot manage clients or schedules', async () => {
    const owner = await pairOwner(env.hub);
    const invite = await env.hub.app.inject({ method: 'POST', url: '/api/v1/pairing-codes', headers: owner, payload: { devices: '*' } });
    expect(invite.statusCode).toBe(201);
    const member = (await pair(invite.json<{ code: string }>().code)).json<{ token: string; role: string }>();
    expect(member.role).toBe('member');
    const headers = { authorization: `Bearer ${member.token}` };
    expect((await env.hub.app.inject({ method: 'GET', url: '/api/v1/clients', headers })).statusCode).toBe(403);
    expect((await env.hub.app.inject({ method: 'POST', url: '/api/v1/pairing-codes', headers, payload: { devices: '*' } })).statusCode).toBe(403);
  });

  it('revokes a client immediately and protects the last owner', async () => {
    const owner = await pairOwner(env.hub);
    const invite = (await env.hub.app.inject({ method: 'POST', url: '/api/v1/pairing-codes', headers: owner, payload: { devices: '*' } })).json<{ code: string }>();
    const member = (await pair(invite.code)).json<{ token: string; clientId: string }>();
    const del = await env.hub.app.inject({ method: 'DELETE', url: `/api/v1/clients/${member.clientId}`, headers: owner });
    expect(del.statusCode).toBe(204);
    const after = await env.hub.app.inject({ method: 'GET', url: '/api/v1/devices', headers: { authorization: `Bearer ${member.token}` } });
    expect(after.statusCode).toBe(401);
    const self = await env.hub.app.inject({ method: 'DELETE', url: `/api/v1/clients/${owner.clientId}`, headers: owner });
    expect(self.statusCode).toBe(409);
  });

  it('rejects requests without a token', async () => {
    expect((await env.hub.app.inject({ method: 'GET', url: '/api/v1/devices' })).statusCode).toBe(401);
    expect((await env.hub.app.inject({ method: 'GET', url: '/api/v1/devices', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
  });

  it('serves health and identity without auth', async () => {
    const health = (await env.hub.app.inject({ method: 'GET', url: '/api/v1/health' })).json();
    expect(health).toMatchObject({ status: 'ok', hubId: 'test-hub', db: 'up', mqtt: 'up', timeSynced: false });
    const id = await env.hub.app.inject({ method: 'GET', url: '/api/v1/hub/identity' });
    expect(id.json()).toMatchObject({ hubId: 'test-hub' });
  });
});

describe('websocket', () => {
  async function connect(): Promise<{ ws: WebSocket; messages: Array<Record<string, unknown>> }> {
    await env.hub.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = env.hub.app.server.address() as { port: number };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`);
    const messages: Array<Record<string, unknown>> = [];
    ws.on('message', (m) => messages.push(JSON.parse(m.toString()) as Record<string, unknown>));
    await new Promise((r) => ws.once('open', r));
    return { ws, messages };
  }

  it('requires auth as the first message', async () => {
    const { ws } = await connect();
    ws.send(JSON.stringify({ type: 'auth', token: 'bad' }));
    const code = await new Promise<number>((r) => ws.once('close', (c) => r(c)));
    expect(code).toBe(4401);
  });

  it('replays events after resumeAfterSeq, then streams live, and closes on revoke', async () => {
    const owner = await pairOwner(env.hub);
    const { ws, messages } = await connect();
    env.hub.events.append('hub.started', { version: 'x' });
    const resumeAfterSeq = env.hub.events.lastSeq() - 1;
    ws.send(JSON.stringify({ type: 'auth', token: owner.authorization.slice(7), resumeAfterSeq }));
    await new Promise((r) => setTimeout(r, 200));
    expect(messages[0]).toMatchObject({ type: 'event' });
    expect(messages.some((m) => m.type === 'ready')).toBe(true);
    env.hub.events.append('device.online', { deviceId: 'd', online: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(messages.at(-1)).toMatchObject({ type: 'event', event: { type: 'device.online' } });

    const closed = new Promise<number>((r) => ws.once('close', (c) => r(c)));
    env.hub.auth.revoke(owner.clientId, { allowLastOwner: true });
    expect(await closed).toBe(4403);
  });
});
