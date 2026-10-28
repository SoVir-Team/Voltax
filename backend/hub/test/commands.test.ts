import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RELAY, BUTTON, pairOwner, startEnv, waitFor, type TestEnv } from './helpers.js';

let env: TestEnv;
let auth: { authorization: string };

beforeEach(async () => {
  env = await startEnv();
  auth = await pairOwner(env.hub);
});
afterEach(async () => env.close());

const send = (body: object, entity = RELAY) =>
  env.hub.app.inject({ method: 'POST', url: `/api/v1/entities/${entity}/commands`, headers: auth, payload: body });

describe('command manager (local path: API -> MQTT -> device)', () => {
  it('confirms only after the device reports the requested state', async () => {
    const commandId = randomUUID();
    const res = await send({ commandId, value: true });
    expect(res.statusCode).toBe(202);
    await env.hub.commands.drain();
    expect(env.hub.commands.get(commandId)?.status).toBe('confirmed');
    expect(env.device.relay).toBe(true);
    expect(env.hub.store.getEntity(RELAY)?.state).toBe(true);
  });

  it('fails (not confirmed) when the device receives but never reports', async () => {
    env.device.ignoreCommands = true;
    const commandId = randomUUID();
    await send({ commandId, value: true, ttlMs: 1000 });
    await env.hub.commands.drain();
    const cmd = env.hub.commands.get(commandId)!;
    expect(cmd.status).toBe('failed');
    expect(cmd.reason).toMatch(/no state confirmation/);
    expect(env.device.received.some((m) => m.payload === 'ON')).toBe(true); // delivered != done
  });

  it('is idempotent on commandId: a repeat never re-executes', async () => {
    const commandId = randomUUID();
    await send({ commandId, value: true });
    await env.hub.commands.drain();
    const again = await send({ commandId, value: true });
    expect(again.statusCode).toBe(200);
    await env.hub.commands.drain();
    expect(env.device.received.filter((m) => m.topic.endsWith('/command'))).toHaveLength(1);
    const sentEvents = env.hub.events.since(0).filter((e) => e.type === 'command.status' && e.payload.status === 'sent');
    expect(sentEvents).toHaveLength(1);
  });

  it('rejects a reused commandId with a different payload (409)', async () => {
    const commandId = randomUUID();
    await send({ commandId, value: true });
    expect((await send({ commandId, value: false })).statusCode).toBe(409);
  });

  it('rejects a command whose deadline already passed (410) and never publishes it', async () => {
    const commandId = randomUUID();
    const res = await send({ commandId, value: true, expiresAt: Date.now() - 1000 });
    expect(res.statusCode).toBe(410);
    await new Promise((r) => setTimeout(r, 200));
    expect(env.device.received).toHaveLength(0);
    expect(env.hub.commands.get(commandId)?.status).toBe('expired');
  });

  it('fails fast when the device is offline and does not replay when it returns', async () => {
    await env.device.goOffline();
    await waitFor(() => !env.hub.store.isDeviceOnline('esp-relay-01'));
    const commandId = randomUUID();
    await send({ commandId, value: true });
    await env.hub.commands.drain();
    expect(env.hub.commands.get(commandId)).toMatchObject({ status: 'failed', reason: 'device offline' });
    await env.device.client.publishAsync('voltax/test-hub/esp-relay-01/status', 'online', { qos: 1, retain: true });
    await new Promise((r) => setTimeout(r, 300));
    expect(env.device.relay).toBe(false);
  });

  it('publishes commands with retain=false (no stale replay on reconnect)', async () => {
    await send({ commandId: randomUUID(), value: true });
    await env.hub.commands.drain();
    expect(env.device.received.every((m) => m.retain === false)).toBe(true);
  });

  it('clears a retained command left on the broker when it (re)connects', async () => {
    const topic = 'voltax/test-hub/esp-relay-01/switch/relay_1/command';
    // Live deliveries arrive with retain=false (MQTT spec), so a leftover is detected on (re)subscribe.
    await env.hub.mqtt.stop();
    await env.device.client.publishAsync(topic, 'ON', { qos: 1, retain: true });
    env.hub.mqtt.start();
    await waitFor(() => env.hub.mqtt.connected);
    await new Promise((r) => setTimeout(r, 300));
    // A fresh subscriber (e.g. a rebooting device) must see no retained command.
    const probe = await (await import('mqtt')).default.connectAsync(env.brokerUrl);
    const seen: string[] = [];
    probe.on('message', (_t, p, packet) => packet.retain && seen.push(p.toString()));
    await probe.subscribeAsync(topic);
    await new Promise((r) => setTimeout(r, 300));
    await probe.endAsync();
    expect(seen.filter((p) => p.length > 0)).toHaveLength(0);
  });

  it('serialises commands per entity; the last one wins', async () => {
    const a = randomUUID();
    const b = randomUUID();
    await send({ commandId: a, value: true });
    await send({ commandId: b, value: false });
    await env.hub.commands.drain();
    expect(env.hub.commands.get(a)?.status).toBe('confirmed');
    expect(env.hub.commands.get(b)?.status).toBe('confirmed');
    expect(env.device.relay).toBe(false);
  });

  it('refuses to command a sensor (422) or unknown entity (404)', async () => {
    expect((await send({ commandId: randomUUID(), value: true }, BUTTON)).statusCode).toBe(422);
    expect((await send({ commandId: randomUUID(), value: true }, 'nope.switch.x')).statusCode).toBe(404);
  });

  it('validates the body (400)', async () => {
    expect((await send({ commandId: 'not-a-uuid', value: true })).statusCode).toBe(400);
  });

  it('marks in-flight commands failed after a restart instead of replaying them', async () => {
    env.hub.db
      .prepare("INSERT INTO commands (command_id, entity_id, value, source, status, issued_at, expires_at) VALUES (?, ?, 1, 'local', 'sent', ?, ?)")
      .run('left-over', RELAY, Date.now(), Date.now() + 60000);
    expect(env.hub.commands.recoverAfterRestart()).toBe(1);
    expect(env.hub.commands.get('left-over')).toMatchObject({ status: 'failed', reason: 'hub restarted' });
  });
});

describe('state handling', () => {
  it('reports device state changes from physical switches as events', async () => {
    const before = env.hub.events.lastSeq();
    await env.device.setRelay(true); // physical wall switch toggled on the ESP32
    await waitFor(() => env.hub.store.getEntity(RELAY)?.state === true);
    const events = env.hub.events.since(before).filter((e) => e.type === 'entity.state');
    expect(events.at(-1)?.payload).toMatchObject({ entityId: RELAY, state: true, retained: false });
  });

  it('ignores duplicate reports (QoS 1 redelivery does not bump the version)', async () => {
    const v = env.hub.store.getEntity(RELAY)!.stateVersion;
    await env.device.setRelay(false);
    await env.device.setRelay(false);
    await new Promise((r) => setTimeout(r, 200));
    expect(env.hub.store.getEntity(RELAY)!.stateVersion).toBe(v);
  });
});
