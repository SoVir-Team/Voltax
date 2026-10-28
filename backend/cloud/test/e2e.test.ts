import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import mqtt from 'mqtt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cloudDownTopic } from '@voltax/contracts';
import { CLOUD_SERVICE_USER } from '../src/broker.js';
import { brokerAuthenticate, buildInternalApi } from '../src/internal.js';
import { HUB_ID, RELAY, pairOwner, startEnv, type LocalBroker, type TestEnv } from '../../hub/test/helpers.js';
import { BROKER_KIND, CLOUD_MOSQUITTO_ACL, freePort, piMosquittoAcl, startCloudBroker, startEmqx, startMosquitto, type TestBroker } from './broker-helper.js';
import { startCloud, type TestCloud, type TestStaff } from './helpers.js';

// Full support lifecycle with the REAL cloud and the REAL hub (backend/hub) talking over an MQTT
// broker that enforces the production broker ACL. Only the ESP32 is simulated.
// Broker: in-process (default), or with VOLTAX_TEST_CLOUD_BROKER=mosquitto|emqx a real one
// (npm run test:brokers). With Mosquitto, the hub's LOCAL broker is real Mosquitto too, running the
// deploy/pi ACL, and the simulated ESP32 logs in with its own device credential.

const SERVICE_PASSWORD = randomUUID();
const NEIGHBOUR = 'neighbour-hub';
let cloud: TestCloud;
let broker: TestBroker;
let internal: FastifyInstance | null = null;
let env: TestEnv;
let home: string;
let support: TestStaff;
let owner: { authorization: string; clientId: string };
let neighbourPassword: string;

async function until<T>(check: () => Promise<T | undefined | false> | T | undefined | false, what: string, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const api = (method: string, url: string, body?: unknown) => cloud.req(method, url, { cookie: support.cookie, body });
const hubApi = async (method: 'GET' | 'POST', url: string) => {
  const res = await env.hub.app.inject({ method, url, headers: { authorization: owner.authorization } });
  return { status: res.statusCode, body: res.json() };
};
const grantOf = async (grantId: string) => (await api('GET', `/api/v1/homes/${home}/grants/${grantId}`)).body;

beforeAll(async () => {
  const brokerPort = await freePort();
  cloud = await startCloud({ transport: null, extra: { broker: { url: `mqtt://127.0.0.1:${brokerPort}`, password: SERVICE_PASSWORD } } });

  // Company side: a home, an installer registers the hub, support is assigned.
  const admin = await cloud.addStaff('PLATFORM_SUPER_ADMIN');
  const installer = await cloud.addStaff('INSTALLER');
  support = await cloud.addStaff('PLATFORM_SUPPORT', 'Ravi Support');
  home = (await cloud.req('POST', '/api/v1/homes', { cookie: admin.cookie, body: { name: 'Sharma residence' } })).body.homeId;
  await cloud.req('POST', '/api/v1/assignments', { cookie: admin.cookie, body: { staffId: installer.staffId, homeId: home } });
  await cloud.req('POST', '/api/v1/assignments', { cookie: admin.cookie, body: { staffId: support.staffId, homeId: home } });
  const enrol = await cloud.req('POST', `/api/v1/homes/${home}/hub`, { cookie: installer.cookie, body: { hubId: HUB_ID } });
  expect(enrol.status).toBe(201);
  expect(enrol.body.commandPublicKeyPem).toContain('BEGIN PUBLIC KEY');
  neighbourPassword = (await cloud.homes.registerHub(await cloud.addHome('Neighbour'), NEIGHBOUR, admin.staffId)).brokerPassword;

  // The cloud broker.
  let localBroker: LocalBroker | undefined;
  if (BROKER_KIND === 'mosquitto') {
    const users = [
      { username: CLOUD_SERVICE_USER, password: SERVICE_PASSWORD },
      { username: HUB_ID, password: enrol.body.brokerPassword as string },
      { username: NEIGHBOUR, password: neighbourPassword },
    ];
    broker = await startMosquitto(users, CLOUD_MOSQUITTO_ACL, brokerPort);
    const hubPassword = randomBytes(16).toString('hex');
    const device = { username: 'esp-relay-01', password: randomBytes(16).toString('hex') };
    const local = await startMosquitto([{ username: 'hub', password: hubPassword }, device], piMosquittoAcl(HUB_ID));
    localBroker = { ...local, hubPassword, device };
  } else if (BROKER_KIND === 'emqx') {
    const secret = randomBytes(24).toString('hex');
    internal = await buildInternalApi({ homes: cloud.homes, cloudServicePassword: SERVICE_PASSWORD, sharedSecret: secret });
    await internal.listen({ host: '127.0.0.1', port: 0 });
    broker = await startEmqx((internal.server.address() as { port: number }).port, secret, brokerPort);
  } else {
    broker = await startCloudBroker((u, p) => brokerAuthenticate(cloud.homes, SERVICE_PASSWORD, u, p), brokerPort);
  }
  await cloud.start();

  // Home side: the real hub, configured with what the installer received.
  env = await startEnv({ cloudUrl: broker.url, cloudPassword: enrol.body.brokerPassword, cloudKeyPem: enrol.body.commandPublicKeyPem, timeSynced: true, localBroker });
  owner = await pairOwner(env.hub);
  await until(() => env.hub.cloud?.connected, 'hub cloud link');
  env.hub.cloud!.sendTelemetry();
  await until(async () => (await api('GET', `/api/v1/homes/${home}/devices`)).body.length > 0, 'telemetry');
}, 180_000);

afterAll(async () => {
  await env?.close();
  await cloud?.close();
  await broker?.close();
  await internal?.close();
}, 60_000);

describe('end to end: support access with the real hub', () => {
  let grantId: string;

  it('telemetry reaches the cloud with device ids and online flags only', async () => {
    expect((await api('GET', `/api/v1/homes/${home}/devices`)).body).toEqual([{ deviceId: 'esp-relay-01', online: true }]);
    const hub = (await api('GET', `/api/v1/homes/${home}/hub`)).body;
    expect(hub).toMatchObject({ hubId: HUB_ID, online: true, timeSynced: true });
  });

  it('a request appears on the hub as pending; nothing works until the owner approves', async () => {
    const res = await api('POST', `/api/v1/homes/${home}/grants`, { deviceIds: ['esp-relay-01'], actions: ['device.command', 'diagnostics.read'], reason: 'relay stuck, customer called support', durationMinutes: 30 });
    expect(res.status).toBe(201);
    grantId = res.body.grantId;
    const onHub = await until(async () => (await hubApi('GET', '/api/v1/support/grants')).body.find((g: { grantId: string }) => g.grantId === grantId), 'grant on hub');
    expect(onHub).toMatchObject({ status: 'pending', staff: { displayName: 'Ravi Support', role: 'PLATFORM_SUPPORT' } });
    const early = await api('POST', `/api/v1/homes/${home}/grants/${grantId}/diagnostics`);
    expect(early.status).toBe(409);
  });

  it('the owner approves on the hub; the hub notifies the owner app and the cloud mirror turns active', async () => {
    expect((await hubApi('POST', `/api/v1/support/grants/${grantId}/approve`)).status).toBe(200);
    const g = await until(async () => {
      const v = await grantOf(grantId);
      return v.status === 'active' && v.ownerNotified ? v : undefined;
    }, 'active grant in cloud');
    expect(g.startNoticeAt).toBeGreaterThan(0);
    expect(env.hub.events.since(0).some((e) => e.type === 'support.started')).toBe(true);
  });

  it('support switches the granted relay; the real hub executes it and the result comes back', async () => {
    const cmd = await api('POST', `/api/v1/homes/${home}/grants/${grantId}/commands`, { entityId: RELAY, value: true });
    expect(cmd.status).toBe(202);
    await until(() => env.device.relay, 'relay on');
    await until(async () => (await api('GET', `/api/v1/homes/${home}/grants/${grantId}/commands`)).body[0]?.status === 'confirmed', 'confirmed');
  });

  it('diagnostics come from the hub and contain no device states', async () => {
    const res = await api('POST', `/api/v1/homes/${home}/grants/${grantId}/diagnostics`);
    expect(res.status).toBe(200);
    expect(res.body.devices).toEqual([expect.objectContaining({ deviceId: 'esp-relay-01', online: true })]);
    expect(JSON.stringify(res.body)).not.toMatch(/"(state|value|relay)"/);
  });

  it('owner revokes while one command is in flight and one is queued: queued cancelled, in-flight reported', async () => {
    env.device.ignoreCommands = true; // the first command is published but never confirmed
    const a = (await api('POST', `/api/v1/homes/${home}/grants/${grantId}/commands`, { entityId: RELAY, value: false })).body.commandId as string;
    await until(() => env.hub.commands.inFlightForGrant(grantId).length === 1, 'command in flight');
    const b = (await api('POST', `/api/v1/homes/${home}/grants/${grantId}/commands`, { entityId: RELAY, value: true })).body.commandId as string;
    await until(() => env.hub.commands.get(b)?.status === 'pending', 'second command queued on hub');

    expect((await hubApi('POST', `/api/v1/support/grants/${grantId}/revoke`)).status).toBe(200);
    expect(env.hub.commands.get(b)).toMatchObject({ status: 'failed', reason: 'grant revoked' });
    const inflight = env.hub.events.since(0).find((e) => e.type === 'support.inflight');
    expect(inflight?.payload).toMatchObject({ grantId, commands: [expect.objectContaining({ commandId: a })] });

    const g = await until(async () => {
      const v = await grantOf(grantId);
      return v.status === 'revoked' ? v : undefined;
    }, 'revoked in cloud');
    expect(g.endReason).toBe('revoked by the owner');
    const cmds = (await api('GET', `/api/v1/homes/${home}/grants/${grantId}/commands`)).body as Array<{ commandId: string; status: string }>;
    expect(cmds.find((c) => c.commandId === b)?.status).toBe('failed');
    env.device.ignoreCommands = false;
  });

  it('after revocation the cloud refuses, and a correctly signed envelope that skips the cloud checks is refused by the hub', async () => {
    expect((await api('POST', `/api/v1/homes/${home}/grants/${grantId}/commands`, { entityId: RELAY, value: true })).status).toBe(409);

    // Simulates a compromised cloud: valid signature, but the hub's own grant record says revoked.
    const relayBefore = env.device.relay;
    const now = Date.now();
    const forged = cloud.signer!.sign({
      v: 1,
      envelopeId: randomUUID(),
      hubId: HUB_ID,
      issuedAt: now,
      expiresAt: now + 20_000,
      actor: { staffId: support.staffId, role: 'PLATFORM_SUPPORT', displayName: 'Ravi Support' },
      type: 'command',
      grantId,
      commandId: randomUUID(),
      entityId: RELAY,
      value: !relayBefore,
    });
    await cloud.broker!.publish(HUB_ID, forged);
    await until(() => env.hub.audit.since(0).find((r) => r.action === 'command' && r.outcome === 'denied'), 'hub refusal');
    expect(env.device.relay).toBe(relayBefore);
  });

  it('the hub’s audit chain arrives in the cloud intact (off-device copy)', async () => {
    const summary = await until(async () => {
      const s = await cloud.hubAudit.summary(HUB_ID);
      return s.records >= env.hub.audit.since(0).length ? s : undefined;
    }, 'hub audit export');
    expect(summary.breaks).toBe(0);
    const actions = (await cloud.hubAudit.list(HUB_ID, 0, 500)).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['grant.request', 'grant.approve', 'device.command', 'grant.revoke']));
  });

  it(`the ${BROKER_KIND} broker keeps hubs apart: a hub credential cannot read or write another hub’s topics`, async () => {
    const client = await mqtt.connectAsync(broker.url, { username: NEIGHBOUR, password: neighbourPassword, clientId: 'neighbour', reconnectPeriod: 0 });
    const seen: string[] = [];
    client.on('message', (topic) => seen.push(topic));
    try {
      const subscribed = await client.subscribeAsync(cloudDownTopic(HUB_ID), { qos: 1 }).then(
        () => true,
        () => false, // SUBACK 0x80
      );
      // aedes and EMQX refuse the subscription; Mosquitto's ACL file accepts it and enforces read
      // access per message instead. Either way nothing may be delivered (checked below).
      if (BROKER_KIND !== 'mosquitto') expect(subscribed).toBe(false);
      // Traffic for the real hub flows, and the neighbour sees none of it.
      const deniedBefore = env.hub.audit.since(0).filter((r) => r.outcome === 'denied').length;
      const now = Date.now();
      await cloud.broker!.publish(
        HUB_ID,
        cloud.signer!.sign({ v: 1, envelopeId: randomUUID(), hubId: HUB_ID, issuedAt: now, expiresAt: now + 20_000, actor: { staffId: support.staffId, role: 'PLATFORM_SUPPORT', displayName: 'Ravi Support' }, type: 'command', grantId, commandId: randomUUID(), entityId: RELAY, value: true }),
      );
      await until(() => env.hub.audit.since(0).filter((r) => r.outcome === 'denied').length > deniedBefore, 'hub received the envelope');
      // Pretending to be the other hub towards the cloud (QoS 0: some brokers drop the connection instead of acknowledging).
      await client.publishAsync(`voltax-cloud/${HUB_ID}/up`, JSON.stringify({ type: 'grant.status', grantId, status: 'active', at: Date.now() })).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 500));
      expect(seen).toEqual([]);
      expect((await grantOf(grantId)).status).toBe('revoked');
      if (broker.denied) expect(broker.denied).toEqual(expect.arrayContaining([`subscribe:${NEIGHBOUR}:${cloudDownTopic(HUB_ID)}`, `publish:${NEIGHBOUR}:voltax-cloud/${HUB_ID}/up`]));
    } finally {
      await client.endAsync();
    }
    // Credentials are bound to their user name, and the service account needs its own secret.
    await expect(mqtt.connectAsync(broker.url, { username: HUB_ID, password: neighbourPassword, clientId: 'y', reconnectPeriod: 0 })).rejects.toThrow();
    await expect(mqtt.connectAsync(broker.url, { username: CLOUD_SERVICE_USER, password: 'wrong', clientId: 'x', reconnectPeriod: 0 })).rejects.toThrow();
  });
});
