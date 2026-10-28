import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PushSubscriptionInput } from '@voltax/contracts';
import { pairOwner, startEnv, waitFor, type TestEnv } from './helpers.js';

// Rooms, promote/demote with the last-owner rule, and opt-in browser notifications.

let env: TestEnv;
let owner: { authorization: string };
const sent: Array<{ endpoint: string; payload: { title: string; body: string; url: string } }> = [];
let status = 201;

beforeEach(async () => {
  sent.length = 0;
  status = 201;
  env = await startEnv({
    pushSender: {
      async send(sub, payload) {
        sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
        return { statusCode: status };
      },
    },
  });
  owner = await pairOwner(env.hub);
});
afterEach(async () => env.close());

const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, headers: object, payload?: object) =>
  env.hub.app.inject({ method, url, headers: headers as Record<string, string>, ...(payload ? { payload } : {}) });

async function pairMember(devices: '*' | string[] = '*') {
  const { code } = (await call('POST', '/api/v1/pairing-codes', owner, { devices })).json<{ code: string }>();
  const { token, clientId } = (await call('POST', '/api/v1/pair', {}, { pairingCode: code, clientName: 'Asha' })).json<{ token: string; clientId: string }>();
  return { headers: { authorization: `Bearer ${token}` }, clientId };
}

const sub = (id: string, host = 'fcm.googleapis.com'): PushSubscriptionInput => ({
  endpoint: `https://${host}/fcm/send/${id}`,
  keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) },
});

describe('rooms', () => {
  it('the owner puts a device in a room; members cannot', async () => {
    expect((await call('PUT', '/api/v1/devices/esp-relay-01/room', owner, { room: 'Kitchen' })).statusCode).toBe(204);
    const devices = (await call('GET', '/api/v1/devices', owner)).json<Array<{ deviceId: string; room: string | null }>>();
    expect(devices.find((d) => d.deviceId === 'esp-relay-01')!.room).toBe('Kitchen');
    const member = await pairMember();
    expect((await call('PUT', '/api/v1/devices/esp-relay-01/room', member.headers, { room: 'Garage' })).statusCode).toBe(403);
    expect((await call('PUT', '/api/v1/devices/esp-relay-01/room', owner, { room: null })).statusCode).toBe(204);
    expect((await call('PUT', '/api/v1/devices/nope/room', owner, { room: 'X' })).statusCode).toBe(404);
  });
});

describe('promote and demote', () => {
  it('promotes a member to owner and demotes back with chosen devices; /me shows the current role', async () => {
    const member = await pairMember(['esp-relay-01']);
    expect((await call('GET', '/api/v1/me', member.headers)).json()).toMatchObject({ role: 'member', devices: ['esp-relay-01'] });
    expect((await call('PUT', `/api/v1/clients/${member.clientId}/role`, owner, { role: 'owner' })).statusCode).toBe(204);
    expect((await call('GET', '/api/v1/me', member.headers)).json()).toMatchObject({ role: 'owner', devices: '*' });
    expect((await call('GET', '/api/v1/clients', member.headers)).statusCode).toBe(200); // owner rights at once

    expect((await call('PUT', `/api/v1/clients/${member.clientId}/role`, owner, { role: 'member', devices: [] })).statusCode).toBe(204);
    expect((await call('GET', '/api/v1/devices', member.headers)).json()).toEqual([]);
    expect(env.hub.audit.since(0).filter((r) => r.action === 'client.role')).toHaveLength(2);
  });

  it('the last owner cannot be demoted, and a member cannot change roles', async () => {
    const me = (await call('GET', '/api/v1/me', owner)).json<{ clientId: string }>();
    expect((await call('PUT', `/api/v1/clients/${me.clientId}/role`, owner, { role: 'member' })).statusCode).toBe(409);
    const member = await pairMember();
    expect((await call('PUT', `/api/v1/clients/${member.clientId}/role`, member.headers, { role: 'owner' })).statusCode).toBe(403);
  });
});

describe('browser notifications', () => {
  it('only accepts real browser push services (no requests to arbitrary hosts)', async () => {
    for (const host of ['evil.example.com', '127.0.0.1', 'fcm.googleapis.com.evil.io']) {
      expect((await call('POST', '/api/v1/push/subscriptions', owner, sub('x', host))).statusCode, host).toBe(400);
    }
    expect((await call('POST', '/api/v1/push/subscriptions', owner, sub('ok'))).statusCode).toBe(204);
    expect((await call('GET', '/api/v1/push/key', owner)).json().publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
  });

  it('owners hear about support requests and updates; members only about devices they may see', async () => {
    await call('POST', '/api/v1/push/subscriptions', owner, sub('owner'));
    const member = await pairMember([]); // no devices
    await call('POST', '/api/v1/push/subscriptions', member.headers, sub('member'));

    env.hub.events.append('support.requested', { grantId: 'g1' });
    env.hub.events.append('update.offered', { rolloutId: 'r1', version: '1.9.0' });
    await env.device.goOffline();
    await waitFor(() => sent.some((s) => s.payload.title.includes('offline')));
    env.hub.events.append('support.started', { grantId: 'g1' });
    await waitFor(() => sent.filter((s) => s.payload.title === 'Support session started').length === 2);

    const to = (who: string) => sent.filter((s) => s.endpoint.endsWith(`/${who}`)).map((s) => s.payload.title);
    expect(to('owner')).toEqual(expect.arrayContaining(['VOLTEX support is asking for access', 'Hub update available', 'Support session started']));
    expect(to('owner').some((t) => t.endsWith('is offline'))).toBe(true);
    expect(to('member')).toEqual(['Support session started']); // not the offline device it cannot see
    expect(JSON.stringify(sent)).not.toMatch(/token|Bearer|"state"/);
  });

  it('a removed client stops getting notifications, and a subscription the service reports gone is forgotten', async () => {
    const member = await pairMember();
    await call('POST', '/api/v1/push/subscriptions', member.headers, sub('member'));
    await call('DELETE', `/api/v1/clients/${member.clientId}`, owner);
    expect(env.hub.push.count(member.clientId)).toBe(0);

    await call('POST', '/api/v1/push/subscriptions', owner, sub('owner'));
    const me = (await call('GET', '/api/v1/me', owner)).json<{ clientId: string; push: number }>();
    expect(me.push).toBe(1);
    status = 410;
    await env.hub.push.onEvent(env.hub.events.append('support.requested', { grantId: 'g2' }));
    expect(env.hub.push.count(me.clientId)).toBe(0);
  });
});
