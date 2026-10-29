// Load-test hub worker: runs a slice of the 120 REAL hubs (createHub from backend/hub/dist), their
// simulated ESPHome relays on a home broker, each home's owner (approves support requests), and the
// hub-side adversarial load (forged and replayed envelopes, broker isolation probes).
// Started by run.mjs with an IPC channel: argv = <plan.json> <workerIndex> <workerCount>.
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Aedes } from 'aedes';
import mqtt from 'mqtt';
import { createServer } from 'node:net';
import { between, load, pick, sleep, until } from './lib.mjs';

const [planFile, indexArg, countArg] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planFile, 'utf8'));
const index = Number(indexArg);
const count = Number(countArg);
const mine = plan.hubs.filter((_, i) => i % count === index);

const { createHub } = await load('backend/hub/dist/hub.js');
const { EnvelopeSigner } = await load('backend/cloud/dist/signer.js');
const { cloudDownTopic, cloudUpTopic } = await load('shared/contracts/dist/index.js');

const stats = {
  worker: index,
  hubs: mine.length,
  devices: 0,
  statePublishes: 0,
  deviceCommands: 0,
  approvals: 0,
  approvalFailures: 0,
  approvalsTooLate: 0, // the requester withdrew first; the hub correctly refuses (409 already decided)
  forged: { sent: 0, refused: 0, accepted: 0, reasons: {} },
  replayed: { sent: 0, refused: 0, accepted: 0, reasons: {} },
  isolation: { probes: 0, violations: [], subscribeGranted: 0, controlFailures: 0 },
  cloudLinkDownSamples: 0,
  // Where time goes when something is slow: hub-side timings, observed only.
  trace: { slowCommands: [], unansweredRequests: [], approvalFailures: [] },
};
const log = (msg) => process.send?.({ type: 'log', worker: index, msg });

// --- home broker (one per worker: topics are per hub, as on each Pi's Mosquitto) -----------------
const broker = await Aedes.createBroker();
const server = createServer(broker.handle);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const homeBrokerUrl = `mqtt://127.0.0.1:${server.address().port}`;

// --- simulated ESPHome relays ------------------------------------------------------------------
const DEVICES_PER_HUB = plan.devicesPerHub;
const deviceTimers = [];
const deviceClients = [];
async function startDevice(hubId, deviceId) {
  const prefix = `voltax/${hubId}/${deviceId}`;
  let on = Math.random() < 0.5;
  const client = await mqtt.connectAsync(homeBrokerUrl, { clientId: `${hubId}-${deviceId}`, clean: true, will: { topic: `${prefix}/status`, payload: Buffer.from('offline'), qos: 1, retain: true } });
  const publishState = () => {
    stats.statePublishes++;
    return client.publishAsync(`${prefix}/switch/relay_1/state`, on ? 'ON' : 'OFF', { qos: 1, retain: true }).catch(() => {});
  };
  client.on('message', (_topic, payload) => {
    const v = payload.toString();
    if (v !== 'ON' && v !== 'OFF') return;
    stats.deviceCommands++;
    on = v === 'ON';
    void publishState();
  });
  await client.subscribeAsync(`${prefix}/switch/relay_1/command`, { qos: 0 });
  await client.publishAsync(`${prefix}/status`, 'online', { qos: 1, retain: true });
  await publishState();
  // State every 30 s (ESPHome update interval), each device on its own phase.
  const first = setTimeout(() => {
    void publishState();
    deviceTimers.push(setInterval(publishState, plan.telemetryMs));
  }, between(0, plan.telemetryMs));
  deviceTimers.push(first);
  deviceClients.push(client);
  stats.devices++;
}

// --- the hubs ------------------------------------------------------------------------------------
const base = mkdtempSync(join(tmpdir(), `voltex-load-hubs-${index}-`));
const hubs = [];
for (const h of mine) {
  const dir = join(base, h.hubId);
  mkdirSync(dir, { recursive: true });
  const syncFile = join(dir, 'time-synced');
  writeFileSync(syncFile, ''); // chrony-synced clock (fail-closed otherwise)
  const hub = await createHub(
    {
      HUB_ID: h.hubId,
      HUB_NAME: h.name,
      DB_PATH: join(dir, 'hub.db'),
      BACKUP_DIR: join(dir, 'backups'),
      MQTT_URL: homeBrokerUrl,
      MQTT_USERNAME: 'hub',
      MQTT_PASSWORD: 'x',
      TZ: 'UTC',
      VOLTAX_VERSION: '1.0.0',
      TIME_SYNC_FILE: syncFile,
      CLOUD_URL: plan.brokerUrl,
      CLOUD_PASSWORD: h.brokerPassword,
      CLOUD_COMMAND_PUBKEY_PEM: plan.commandPublicKeyPem,
      TELEMETRY_INTERVAL_MS: plan.telemetryMs,
      UPDATE_DIR: join(dir, 'update-request'),
      pushSender: null,
    },
    { logger: false },
  );
  await hub.start();

  // The home owner's phone, paired through the real API.
  const { code } = hub.auth.createPairingCode('owner');
  const paired = (await hub.app.inject({ method: 'POST', url: '/api/v1/pair', payload: { pairingCode: code, clientName: 'owner phone' } })).json();
  const handle = hub.grants.handle.bind(hub.grants);
  const entry = { ...h, hub, handle, owner: `Bearer ${paired.token}`, scheduled: new Set(), lastCommand: null, refusals: [], commandsIn: new Map(), requestsIn: new Map() };

  // Observe (never alter) what reaches and leaves the hub: real command envelopes arriving over the
  // cloud link are kept for the replay check, refusals are counted. Both wrappers call straight through.
  hub.grants.handle = (raw) => {
    try {
      const env = raw && typeof raw.payload === 'string' ? JSON.parse(raw.payload) : null;
      if (env?.type === 'command') {
        entry.lastCommand = { raw, at: Date.now() };
        entry.commandsIn.set(env.commandId, { at: Date.now(), issuedAt: env.issuedAt });
      }
      if (env?.type === 'diagnostics.request' || env?.type === 'activity.request') {
        entry.requestsIn.set(env.requestId, { at: Date.now(), issuedAt: env.issuedAt, envelopeId: env.envelopeId, type: env.type, linkUp: hub.cloud.connected });
      }
    } catch {
      /* malformed: the hub refuses it */
    }
    handle(raw);
  };
  hub.grants.setSink((msg) => {
    if (msg.type === 'envelope.rejected') {
      entry.refusals.push(msg.reason);
      for (const [id, r] of entry.requestsIn) if (r.envelopeId && r.envelopeId === msg.envelopeId) entry.requestsIn.delete(id);
    }
    if (msg.type === 'diagnostics.result' || msg.type === 'activity.result') entry.requestsIn.delete(msg.requestId);
    if (msg.type === 'command.result' && ['confirmed', 'failed', 'expired'].includes(msg.status)) {
      const c = entry.commandsIn.get(msg.commandId);
      entry.commandsIn.delete(msg.commandId);
      if (c && Date.now() - c.issuedAt > 5000 && stats.trace.slowCommands.length < 50) {
        stats.trace.slowCommands.push({ hubId: h.hubId, commandId: msg.commandId, status: msg.status, cloudToHubMs: c.at - c.issuedAt, hubMs: Date.now() - c.at });
      }
    }
    hub.cloud.send(msg);
  });
  hubs.push(entry);
  for (let d = 1; d <= DEVICES_PER_HUB; d++) await startDevice(h.hubId, `relay-${String(d).padStart(2, '0')}`);
}
const notReady = () => hubs.filter((e) => !e.hub.cloud.connected || e.hub.store.listDevices().filter((d) => d.online).length !== DEVICES_PER_HUB);
try {
  await until(async () => notReady().length === 0, 'hubs connected with all devices online', 180_000);
} catch (err) {
  const e = notReady()[0];
  log(`${notReady().length} hubs not ready; e.g. ${e.hubId}: cloud ${e.hub.cloud.connected}, devices online ${e.hub.store.listDevices().filter((d) => d.online).length}/${e.hub.store.listDevices().length}, mqtt ${e.hub.mqtt.connected}`);
  await sleep(500);
  throw err;
}
for (const e of hubs) e.hub.cloud.sendTelemetry();
process.send?.({ type: 'ready', worker: index, hubs: hubs.length, devices: stats.devices });

// --- home owners approve support requests 2-5 s after they arrive ------------------------------
const ownerTimer = setInterval(() => {
  for (const e of hubs) {
    const pending = e.hub.db.prepare("SELECT grant_id FROM support_grants WHERE status = 'pending'").all();
    for (const { grant_id: grantId } of pending) {
      if (e.scheduled.has(grantId)) continue;
      e.scheduled.add(grantId);
      setTimeout(async () => {
        const res = await e.hub.app.inject({ method: 'POST', url: `/api/v1/support/grants/${grantId}/approve`, headers: { authorization: e.owner } });
        if (res.statusCode === 200) stats.approvals++;
        else if (res.statusCode === 409 && res.body.includes('already decided')) stats.approvalsTooLate++;
        else {
          stats.approvalFailures++;
          if (stats.trace.approvalFailures.length < 20) stats.trace.approvalFailures.push({ hubId: e.hubId, grantId, status: res.statusCode, body: res.body.slice(0, 200) });
        }
      }, between(2000, 5000));
    }
  }
}, 1000);

// --- forged and replayed envelopes (every 10 s) -------------------------------------------------
const wrongKey = new EnvelopeSigner(generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
function tryEnvelope(e, raw, bucket) {
  const before = e.refusals.length;
  bucket.sent++;
  e.handle(raw); // the hub's own handler (not the capture wrapper); verification is synchronous
  const reason = e.refusals.length > before ? e.refusals[e.refusals.length - 1] : null;
  if (reason) {
    bucket.refused++;
    bucket.reasons[reason] = (bucket.reasons[reason] ?? 0) + 1;
  } else {
    bucket.accepted++;
  }
}
const adversaryTimer = setInterval(() => {
  // Forged: a well-formed command for this hub (a real grant and entity when one is known), signed with the wrong key.
  const target = pick(hubs);
  const real = target.lastCommand ? JSON.parse(target.lastCommand.raw.payload) : null;
  const now = Date.now();
  const forged = wrongKey.sign({
    v: 1,
    envelopeId: randomUUID(),
    hubId: target.hubId,
    issuedAt: now,
    expiresAt: now + 20_000,
    actor: real?.actor ?? { staffId: randomUUID(), role: 'PLATFORM_SUPPORT', displayName: 'Forger' },
    type: 'command',
    grantId: real?.grantId ?? randomUUID(),
    commandId: randomUUID(),
    entityId: real?.entityId ?? 'relay-01.switch.relay_1',
    value: true,
  });
  tryEnvelope(target, forged, stats.forged);

  // Replayed: the most recent real command envelope this worker saw, sent to its hub again.
  const withCommand = hubs.filter((e) => e.lastCommand).sort((a, b) => b.lastCommand.at - a.lastCommand.at)[0];
  if (withCommand) tryEnvelope(withCommand, withCommand.lastCommand.raw, stats.replayed);
}, 10_000);

// --- broker isolation probe (every 60 s): hub A's own credential against hub B's topics ---------
async function isolationProbe() {
  if (hubs.length < 2) return;
  const a = pick(hubs);
  const b = pick(hubs.filter((x) => x !== a));
  const marker = `isolation-probe-${randomUUID()}`;
  const seenByAttacker = [];
  const seenByService = [];
  const attacker = await mqtt.connectAsync(plan.brokerUrl, { username: a.hubId, password: a.brokerPassword, clientId: `probe-${a.hubId}-${randomUUID().slice(0, 8)}`, reconnectPeriod: 0 });
  const service = await mqtt.connectAsync(plan.brokerUrl, { username: plan.serviceUser, password: plan.servicePassword, clientId: `probe-svc-${randomUUID().slice(0, 8)}`, reconnectPeriod: 0 });
  // Positive control: hub B's own credential DOES see the cloud's marker and DOES reach the cloud,
  // so a probe that sees nothing proves isolation rather than a broken probe.
  const control = await mqtt.connectAsync(plan.brokerUrl, { username: b.hubId, password: b.brokerPassword, clientId: `probe-ctl-${b.hubId}-${randomUUID().slice(0, 8)}`, reconnectPeriod: 0 });
  const controlSaw = [];
  const controlMarker = `control-${randomUUID()}`; // unrelated to `marker`, so a control message is never mistaken for a leak
  try {
    control.on('message', (_t, payload) => payload.toString().includes(marker) && controlSaw.push('down'));
    service.on('message', (topic, payload) => topic === cloudUpTopic(b.hubId) && payload.toString().includes(controlMarker) && controlSaw.push('up'));
    await control.subscribeAsync(cloudDownTopic(b.hubId), { qos: 1 });
    attacker.on('message', (topic, payload) => payload.toString().includes(marker) && seenByAttacker.push(topic));
    service.on('message', (topic, payload) => topic === cloudUpTopic(b.hubId) && payload.toString().includes(marker) && seenByService.push(topic));
    // EMQX answers 0x80 (refused) per topic; mqtt.js reports that as an error carrying the SUBACK.
    const granted = await attacker.subscribeAsync([cloudDownTopic(b.hubId), cloudUpTopic(b.hubId)], { qos: 1 }).then(
      (g) => g.map((x) => x.qos),
      (err) => err.packet?.granted ?? [],
    );
    stats.isolation.subscribeGranted += granted.filter((q) => q !== 128).length;
    await service.subscribeAsync('voltax-cloud/+/up', { qos: 1 }); // the only form the service ACL allows
    // A tries to speak as B (to the cloud) and as the cloud (to B).
    await attacker.publishAsync(cloudUpTopic(b.hubId), JSON.stringify({ type: 'telemetry', marker }), { qos: 1 }).catch(() => {});
    await attacker.publishAsync(cloudDownTopic(b.hubId), JSON.stringify({ payload: marker, sig: 'x' }), { qos: 1 }).catch(() => {});
    // The cloud's own message to B (hub B refuses it as malformed): A must not see it.
    await service.publishAsync(cloudDownTopic(b.hubId), JSON.stringify({ payload: `{"marker":"${marker}"}`, sig: 'eA==' }), { qos: 1 });
    await control.publishAsync(cloudUpTopic(b.hubId), JSON.stringify({ type: 'telemetry', marker: controlMarker }), { qos: 1 });
    await sleep(3000);
  } finally {
    attacker.end(true);
    service.end(true);
    control.end(true);
  }
  stats.isolation.probes++;
  if (!controlSaw.includes('down') || !controlSaw.includes('up')) stats.isolation.controlFailures++;
  for (const topic of seenByAttacker) stats.isolation.violations.push({ at: Date.now(), who: a.hubId, saw: topic });
  for (const topic of seenByService) stats.isolation.violations.push({ at: Date.now(), who: a.hubId, wroteAs: topic });
}
const isolationTimer = setInterval(() => void isolationProbe().catch((err) => log(`isolation probe error: ${err.message}`)), 60_000);
const linkTimer = setInterval(() => {
  stats.cloudLinkDownSamples += hubs.filter((e) => !e.hub.cloud.connected).length;
}, 10_000);

process.on('message', async (m) => {
  if (m?.type !== 'stop') return;
  clearInterval(ownerTimer);
  clearInterval(adversaryTimer);
  clearInterval(isolationTimer);
  clearInterval(linkTimer);
  for (const t of deviceTimers) clearInterval(t);
  for (const e of hubs) {
    for (const [requestId, r] of e.requestsIn) {
      if (Date.now() - r.at > 10_000 && stats.trace.unansweredRequests.length < 50) stats.trace.unansweredRequests.push({ hubId: e.hubId, requestId, ...r, cloudToHubMs: r.at - r.issuedAt });
    }
  }
  process.send?.({ type: 'stats', stats });
  for (const c of deviceClients) c.end(true);
  for (const e of hubs) await e.hub.stop().catch(() => {});
  await new Promise((r) => broker.close(() => server.close(() => r())));
  rmSync(base, { recursive: true, force: true });
  process.exit(0);
});
