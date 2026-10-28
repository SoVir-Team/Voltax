import { randomUUID } from 'node:crypto';
import mqtt from 'mqtt';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { HOME_ACTIONS } from '@voltax/contracts';
import { assertGuarded, PUBLIC_API_ROUTES } from '../src/api.js';
import { GENESIS_HASH } from '../src/audit.js';
import { HUB_ID, RELAY, pairOwner, startEnv, waitFor, type TestEnv } from './helpers.js';

const OTHER = 'esp-relay-02.switch.relay_1';

let env: TestEnv;
let owner: { authorization: string; clientId: string };

/** A second device that only reports (enough for scoping tests). */
async function addSecondDevice(): Promise<void> {
  const c = await mqtt.connectAsync(env.brokerUrl, { clientId: 'esp-relay-02' });
  await c.publishAsync(`voltax/${HUB_ID}/esp-relay-02/status`, 'online', { qos: 1, retain: true });
  await c.publishAsync(`voltax/${HUB_ID}/esp-relay-02/switch/relay_1/state`, 'OFF', { qos: 1, retain: true });
  await waitFor(() => env.hub.store.getEntity(OTHER) !== null && env.hub.store.isDeviceOnline('esp-relay-02'));
  await c.endAsync();
}

const req = (method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH', url: string, authorization?: string, payload?: object) =>
  env.hub.app.inject({ method, url, payload, headers: authorization ? { authorization } : {} });

async function pairMember(devices: '*' | string[]): Promise<{ authorization: string; clientId: string; token: string }> {
  const invite = await req('POST', '/api/v1/pairing-codes', owner.authorization, { devices });
  expect(invite.statusCode).toBe(201);
  const res = await env.hub.app.inject({
    method: 'POST',
    url: '/api/v1/pair',
    payload: { pairingCode: invite.json<{ code: string }>().code, clientName: 'kid tablet' },
  });
  const body = res.json<{ token: string; clientId: string; role: string }>();
  expect(body.role).toBe('member');
  return { authorization: `Bearer ${body.token}`, clientId: body.clientId, token: body.token };
}

beforeEach(async () => {
  env = await startEnv();
  await addSecondDevice();
  owner = await pairOwner(env.hub);
});
afterEach(async () => env.close());

describe('deny-by-default routing', () => {
  it('every /api route declares a permission; only health, identity and pair are public', () => {
    const guards = env.hub.app.routeGuards;
    expect(guards.length).toBeGreaterThan(15);
    const publicRoutes = guards.filter((g) => 'public' in g.guard).map((g) => `${g.method} ${g.url}`);
    expect(publicRoutes.sort()).toEqual([...PUBLIC_API_ROUTES].sort());
    for (const g of guards) if (!('public' in g.guard)) expect(HOME_ACTIONS).toContain(g.guard.action);
  });

  it('refuses to register an unguarded or wrongly public /api route', () => {
    expect(() => assertGuarded('GET', '/api/v1/secret', undefined)).toThrow(/no permission guard/);
    expect(() => assertGuarded('POST', '/api/v1/devices', { public: true })).toThrow(/public allow-list/);
    expect(() => assertGuarded('GET', '/index.html', undefined)).not.toThrow();
  });

  it('rejects requests without a token, with a bad token and with a revoked token', async () => {
    expect((await req('GET', '/api/v1/devices')).statusCode).toBe(401);
    expect((await req('GET', '/api/v1/devices', 'Bearer nope')).statusCode).toBe(401);
    const member = await pairMember('*');
    expect((await req('DELETE', `/api/v1/clients/${member.clientId}`, owner.authorization)).statusCode).toBe(204);
    expect((await req('GET', '/api/v1/devices', member.authorization)).statusCode).toBe(401);
  });

  it('ignores a role the client claims: the role is read from the token on the server', async () => {
    const member = await pairMember('*');
    const res = await env.hub.app.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      headers: { authorization: member.authorization, 'x-voltax-role': 'owner' },
      payload: { name: 'x', cron: '0 7 * * *', entityId: RELAY, value: true },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('family member boundaries', () => {
  it('requires the owner to choose devices when inviting', async () => {
    expect((await req('POST', '/api/v1/pairing-codes', owner.authorization, {})).statusCode).toBe(400);
  });

  it('sees only granted devices, and other devices look missing', async () => {
    const member = await pairMember(['esp-relay-01']);
    const devices = (await req('GET', '/api/v1/devices', member.authorization)).json<Array<{ deviceId: string }>>();
    expect(devices.map((d) => d.deviceId)).toEqual(['esp-relay-01']);

    const own = await req('POST', `/api/v1/entities/${RELAY}/commands`, member.authorization, { commandId: randomUUID(), value: true });
    expect(own.statusCode).toBe(202);
    const other = await req('POST', `/api/v1/entities/${OTHER}/commands`, member.authorization, { commandId: randomUUID(), value: true });
    expect(other.statusCode).toBe(404);
    const missing = await req('POST', '/api/v1/entities/nope.switch.x/commands', member.authorization, { commandId: randomUUID(), value: true });
    expect(other.json()).toEqual(missing.json()); // indistinguishable: no enumeration
  });

  it('cannot read commands, events, schedules or automations of other devices', async () => {
    const ownerCmd = await req('POST', `/api/v1/entities/${OTHER}/commands`, owner.authorization, { commandId: randomUUID(), value: true });
    const cmdId = ownerCmd.json<{ commandId: string }>().commandId;
    await req('POST', '/api/v1/schedules', owner.authorization, { name: 'other', cron: '0 7 * * *', entityId: OTHER, value: true });
    await req('POST', '/api/v1/schedules', owner.authorization, { name: 'mine', cron: '0 8 * * *', entityId: RELAY, value: true });
    await req('POST', '/api/v1/automations', owner.authorization, {
      name: 'cross',
      trigger: { entityId: RELAY, to: true },
      action: { entityId: OTHER, value: true },
    });
    await env.hub.commands.drain();

    const member = await pairMember(['esp-relay-01']);
    expect((await req('GET', `/api/v1/commands/${cmdId}`, member.authorization)).statusCode).toBe(404);
    const events = (await req('GET', '/api/v1/events', member.authorization)).json<Array<{ payload: Record<string, unknown> }>>();
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain('esp-relay-02');
    const schedules = (await req('GET', '/api/v1/schedules', member.authorization)).json<Array<{ name: string }>>();
    expect(schedules.map((s) => s.name)).toEqual(['mine']);
    expect((await req('GET', '/api/v1/automations', member.authorization)).json()).toEqual([]);
  });

  it('cannot use any owner-only action', async () => {
    const member = await pairMember('*');
    const attempts = [
      req('POST', '/api/v1/pairing-codes', member.authorization, { devices: '*' }),
      req('GET', '/api/v1/clients', member.authorization),
      req('PUT', `/api/v1/clients/${member.clientId}/devices`, member.authorization, { devices: '*' }),
      req('DELETE', `/api/v1/clients/${owner.clientId}`, member.authorization),
      req('DELETE', '/api/v1/devices/esp-relay-02', member.authorization),
      req('PATCH', '/api/v1/devices/esp-relay-01', member.authorization, { name: 'x' }),
      req('POST', '/api/v1/schedules', member.authorization, { name: 'x', cron: '0 7 * * *', entityId: RELAY, value: true }),
      req('POST', '/api/v1/automations', member.authorization, { name: 'x', trigger: { entityId: RELAY, to: true }, action: { entityId: RELAY, value: false } }),
      req('GET', '/api/v1/audit', member.authorization),
    ];
    for (const res of await Promise.all(attempts)) expect(res.statusCode).toBe(403);
  });

  it('applies a change of devices immediately, including on an open WebSocket', async () => {
    const member = await pairMember(['esp-relay-01']);
    const address = await env.hub.app.listen({ port: 0, host: '127.0.0.1' });
    const ws = new WebSocket(`${address.replace('http', 'ws')}/api/v1/ws`);
    const seen: string[] = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as { type: string; event?: { payload: Record<string, unknown> } };
      if (msg.type === 'event') seen.push(JSON.stringify(msg.event!.payload));
      if (msg.type === 'ready') seen.push('ready');
    });
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'auth', token: member.token }));
    await waitFor(() => seen.includes('ready'));

    env.hub.store.setDeviceOnline('esp-relay-02', false);
    env.hub.events.append('device.online', { deviceId: 'esp-relay-02', online: false });
    env.hub.events.append('device.online', { deviceId: 'esp-relay-01', online: true });
    await waitFor(() => seen.some((s) => s.includes('esp-relay-01')));
    expect(seen.some((s) => s.includes('esp-relay-02'))).toBe(false);

    expect((await req('PUT', `/api/v1/clients/${member.clientId}/devices`, owner.authorization, { devices: ['esp-relay-02'] })).statusCode).toBe(204);
    expect((await req('GET', '/api/v1/devices', member.authorization)).json<Array<{ deviceId: string }>>().map((d) => d.deviceId)).toEqual(['esp-relay-02']);
    env.hub.events.append('device.online', { deviceId: 'esp-relay-02', online: true });
    await waitFor(() => seen.some((s) => s.includes('esp-relay-02')));
    ws.close();
  });

  it('owners always have every device; their scope cannot be narrowed', async () => {
    expect((await req('PUT', `/api/v1/clients/${owner.clientId}/devices`, owner.authorization, { devices: [] })).statusCode).toBe(409);
  });
});

describe('hub audit log', () => {
  it('records security events without secrets and verifies its hash chain', async () => {
    const member = await pairMember(['esp-relay-01']);
    await req('POST', `/api/v1/entities/${OTHER}/commands`, member.authorization, { commandId: randomUUID(), value: true });
    await req('GET', '/api/v1/clients', member.authorization);
    await req('GET', '/api/v1/devices', 'Bearer stolen-or-guessed');

    const res = await req('GET', '/api/v1/audit', owner.authorization);
    const { records, verify } = res.json<{ records: Array<{ action: string; outcome: string; prevHash: string }>; verify: { ok: boolean } }>();
    expect(verify.ok).toBe(true);
    expect(records[0]!.prevHash).toBe(GENESIS_HASH);
    const summary = records.map((r) => `${r.action}:${r.outcome}`);
    expect(summary).toEqual(
      expect.arrayContaining(['client.pair:ok', 'client.invite:ok', 'device.command:denied', 'client.manage:denied', 'auth.failed:denied']),
    );
    const dump = JSON.stringify(env.hub.db.prepare('SELECT * FROM audit_log').all());
    expect(dump).not.toContain(member.token);
    expect(dump).not.toContain(owner.authorization.slice(7));
    expect(dump).not.toContain('stolen-or-guessed');
  });

  it('refuses updates and deletes, and detects tampering', () => {
    env.hub.audit.append({ actor: 'hub', action: 'test', outcome: 'ok', details: { token: 'abc', nested: { password: 'p' } } });
    const row = env.hub.db.prepare("SELECT details FROM audit_log WHERE action = 'test'").get() as { details: string };
    expect(row.details).not.toContain('abc');
    expect(row.details).toContain('[redacted]');

    expect(() => env.hub.db.prepare("UPDATE audit_log SET outcome = 'denied'").run()).toThrow(/append-only/);
    expect(() => env.hub.db.prepare('DELETE FROM audit_log').run()).toThrow(/append-only/);

    // Someone with direct database access drops the trigger and edits a record: verify() notices.
    env.hub.db.exec('DROP TRIGGER audit_log_no_update');
    env.hub.db.prepare("UPDATE audit_log SET actor = 'someone-else' WHERE action = 'test'").run();
    const v = env.hub.audit.verify();
    expect(v.ok).toBe(false);
  });
});
