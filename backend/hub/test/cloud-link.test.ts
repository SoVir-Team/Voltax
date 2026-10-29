import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import mqtt, { type MqttClient } from 'mqtt';
import { afterEach, describe, expect, it } from 'vitest';
import { cloudDownTopic, cloudUpTopic, hubAuditRecordSchema, hubMessageSchema, telemetrySchema, type HubMessage } from '@voltax/contracts';
import { auditHash, GENESIS_HASH } from '../src/audit.js';
import { HUB_ID, pairOwner, startBroker, startEnv, waitFor, type TestEnv } from './helpers.js';

const cloud = generateKeyPairSync('ed25519');
const pem = cloud.publicKey.export({ type: 'spki', format: 'pem' }).toString();

let env: TestEnv | undefined;
let cloudBroker: Awaited<ReturnType<typeof startBroker>> | undefined;
let observer: MqttClient | undefined;

afterEach(async () => {
  await observer?.endAsync();
  await env?.close();
  await cloudBroker?.close();
  env = undefined;
  cloudBroker = undefined;
  observer = undefined;
});

async function withCloud(): Promise<{ up: HubMessage[] }> {
  cloudBroker = await startBroker();
  observer = await mqtt.connectAsync(cloudBroker.url, { clientId: 'cloud-test' });
  const up: HubMessage[] = [];
  observer.on('message', (topic, payload) => {
    if (topic === cloudUpTopic(HUB_ID)) up.push(JSON.parse(payload.toString()) as HubMessage);
  });
  await observer.subscribeAsync(cloudUpTopic(HUB_ID), { qos: 1 });
  env = await startEnv({ cloudKeyPem: pem, timeSynced: true, cloudUrl: cloudBroker.url });
  await waitFor(() => env!.hub.cloud!.connected);
  return { up };
}

describe('cloud link', () => {
  it('is off by default: a hub without CLOUD_URL never connects anywhere', async () => {
    env = await startEnv({ connectDevice: false });
    expect(env.hub.cloud).toBeNull();
  });

  it('sends allow-listed telemetry only: no device names, switch states or schedules', async () => {
    const { up } = await withCloud();
    env!.hub.cloud!.sendTelemetry(); // the device is online now
    const withDevice = (m: HubMessage) => m.type === 'telemetry' && m.telemetry.devices.length > 0;
    await waitFor(() => up.some(withDevice));
    const t = up.find(withDevice) as Extract<HubMessage, { type: 'telemetry' }>;
    expect(telemetrySchema.safeParse(t.telemetry).success).toBe(true);
    expect(t.telemetry.devices).toEqual([{ deviceId: 'esp-relay-01', online: true }]);
    const raw = JSON.stringify(t);
    expect(raw).not.toMatch(/relay_1|boot_button|"state":(true|false)|"name"/);
  });

  it('announces whether the home has an owner, with a fresh one-time challenge, alongside telemetry', async () => {
    const { up } = await withCloud();
    env!.hub.cloud!.sendTelemetry();
    await waitFor(() => up.some((m) => m.type === 'customer.ready'));
    const ready = up.find((m) => m.type === 'customer.ready') as Extract<HubMessage, { type: 'customer.ready' }>;
    expect(ready.claimed).toBe(false);
    expect(ready.challenge).toBe(env!.hub.customers.ready().challenge);
  });

  it('delivers signed envelopes from its own down topic to the grant service and answers on up', async () => {
    const { up } = await withCloud();
    const grantId = randomUUID();
    const now = Date.now();
    const envelope = {
      v: 1,
      envelopeId: randomUUID(),
      hubId: HUB_ID,
      issuedAt: now,
      expiresAt: now + 60_000,
      actor: { staffId: randomUUID(), role: 'PLATFORM_SUPPORT', displayName: 'Asha' },
      type: 'grant.request',
      grant: { grantId, deviceIds: ['esp-relay-01'], actions: ['device.command'], reason: 'Relay does not respond', startsAt: now, endsAt: now + 3_600_000 },
    };
    const payload = JSON.stringify(envelope);
    const msg = { payload, sig: sign(null, Buffer.from(payload), cloud.privateKey).toString('base64') };
    await observer!.publishAsync(cloudDownTopic(HUB_ID), JSON.stringify(msg), { qos: 1 });
    await waitFor(() => up.some((m) => m.type === 'grant.status' && m.grantId === grantId && m.status === 'pending'));
    for (const m of up) expect(hubMessageSchema.safeParse(m).success).toBe(true);

    // A message for another hub's topic is never even received by this hub.
    await observer!.publishAsync(cloudDownTopic('neighbour-hub'), JSON.stringify(msg), { qos: 1 });
    await new Promise((r) => setTimeout(r, 200));
    expect(env!.hub.grants.list()).toHaveLength(1);

    // Garbage on the down topic is refused and reported, never crashes the hub.
    await observer!.publishAsync(cloudDownTopic(HUB_ID), 'not json', { qos: 1 });
    await waitFor(() => up.some((m) => m.type === 'envelope.rejected' && m.reason === 'malformed envelope'));
  });

  it('copies the audit log off the hub, in order, with an intact hash chain, exactly once', async () => {
    const { up } = await withCloud();
    await pairOwner(env!.hub); // creates audit records
    env!.hub.audit.append({ actor: 'hub', action: 'test.event', outcome: 'ok' });
    await waitFor(() => up.some((m) => m.type === 'audit.batch' && m.records.some((r) => r.action === 'test.event')));
    const records = up.flatMap((m) => (m.type === 'audit.batch' ? m.records : []));
    const seqs = records.map((r) => r.seq);
    expect(new Set(seqs).size).toBe(seqs.length); // no duplicates
    let prev = GENESIS_HASH;
    for (const r of records) {
      expect(hubAuditRecordSchema.safeParse(r).success).toBe(true);
      expect(r.prevHash).toBe(prev);
      expect(auditHash(prev, r)).toBe(r.hash);
      prev = r.hash;
    }
    const cursor = env!.hub.db.prepare("SELECT value FROM hub_meta WHERE key = 'audit_exported_seq'").get() as { value: string };
    expect(Number(cursor.value)).toBe(seqs[seqs.length - 1]);
  });
});

describe('update hand-off to the host', () => {
  it('writes an atomic request with a valid version only, and reads the host result', async () => {
    env = await startEnv({ connectDevice: false });
    const dir = join(env.dir, 'update-request');
    expect(() => env!.hub.updates.request('1.2.3; rm -rf /')).toThrow(/invalid version/);
    env.hub.updates.request('1.2.3', 'r-1');
    expect(JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8'))).toMatchObject({ version: '1.2.3', rolloutId: 'r-1' });
    expect(existsSync(join(dir, '.request.json.tmp'))).toBe(false);
    expect(env.hub.updates.state()).toEqual({ state: 'requested' });

    // The host updater consumes the request and reports.
    writeFileSync(join(dir, 'result.json'), JSON.stringify({ version: '1.2.3', state: 'done', at: Date.now() }));
    const { rmSync } = await import('node:fs');
    rmSync(join(dir, 'request.json'));
    expect(env.hub.updates.state()).toEqual({ state: 'done', version: '1.2.3' });
    writeFileSync(join(dir, 'result.json'), '{"state":"pwned"}');
    expect(env.hub.updates.state()).toEqual({ state: 'idle' });
  });
});
