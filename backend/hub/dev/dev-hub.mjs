// Development only: runs the real hub against an in-memory MQTT broker and
// simulated ESPHome devices, serving the UI from frontend/web/out (npm run build -w frontend/web) over plain HTTP
// on localhost (a secure context, so the PWA service worker works).
//   npm run dev -w backend/hub        then open http://localhost:8080
// --demo: also plays the VOLTEX cloud with a throwaway signing key (made in memory, never saved):
// a support request and a hub update offer arrive signed, so those screens can be tried locally.
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Aedes } from 'aedes';
import mqtt from 'mqtt';
import { createHub } from '../dist/hub.js';

const HUB_ID = 'dev-hub';
const DEMO = process.argv.includes('--demo');
const cloudKey = DEMO ? generateKeyPairSync('ed25519') : null;
const PORT = Number(process.env.PORT ?? 8080);
const MQTT_PORT = Number(process.env.MQTT_PORT ?? 18830);
// --mailpit: customer email to a local Mailpit (docker run -p 1025:1025 -p 8025:8025 axllent/mailpit).
const SMTP_URL = process.env.DEV_SMTP_URL ?? (process.argv.includes('--mailpit') ? 'smtp://127.0.0.1:1025' : undefined);
const dataDir = fileURLToPath(new URL('../.dev-data/', import.meta.url));
mkdirSync(dataDir, { recursive: true });

const broker = await Aedes.createBroker();
await new Promise((r) => createServer(broker.handle).listen(MQTT_PORT, '127.0.0.1', r));
const MQTT_URL = `mqtt://127.0.0.1:${MQTT_PORT}`;

// Simulated ESP32s: each relay obeys ON/OFF and reports its state, like ESPHome does.
const DEVICES = [
  { id: 'living-room', switches: ['ceiling_light', 'fan'], sensors: ['motion'] },
  { id: 'kitchen', switches: ['lights'], sensors: [] },
  { id: 'bedroom', switches: ['lamp', 'ac_socket'], sensors: ['door'] },
];
for (const dev of DEVICES) {
  const prefix = `voltax/${HUB_ID}/${dev.id}`;
  const client = await mqtt.connectAsync(MQTT_URL, {
    clientId: dev.id,
    will: { topic: `${prefix}/status`, payload: Buffer.from('offline'), qos: 1, retain: true },
  });
  const state = Object.fromEntries(dev.switches.map((s) => [s, false]));
  client.on('message', (topic, payload) => {
    const sw = topic.split('/')[4];
    const v = payload.toString();
    if (!(sw in state) || (v !== 'ON' && v !== 'OFF')) return;
    state[sw] = v === 'ON';
    setTimeout(() => client.publish(`${prefix}/switch/${sw}/state`, v, { qos: 1, retain: true }), 150); // relay latency
  });
  await client.subscribeAsync(`${prefix}/switch/+/command`);
  await client.publishAsync(`${prefix}/status`, 'online', { qos: 1, retain: true });
  for (const sw of dev.switches) await client.publishAsync(`${prefix}/switch/${sw}/state`, 'OFF', { qos: 1, retain: true });
  for (const s of dev.sensors) {
    await client.publishAsync(`${prefix}/binary_sensor/${s}/state`, 'OFF', { qos: 1, retain: true });
    // Sensor activity every ~20 s so live updates are visible.
    setInterval(() => {
      client.publish(`${prefix}/binary_sensor/${s}/state`, 'ON', { qos: 1, retain: true });
      setTimeout(() => client.publish(`${prefix}/binary_sensor/${s}/state`, 'OFF', { qos: 1, retain: true }), 4000);
    }, 20000 + Math.random() * 5000);
  }
}

const hub = await createHub(
  {
    HUB_ID,
    HUB_NAME: 'My Home',
    DB_PATH: `${dataDir}hub.db`,
    BACKUP_DIR: `${dataDir}backups`,
    MQTT_URL,
    MQTT_USERNAME: 'hub',
    MQTT_PASSWORD: 'dev',
    TZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
    VOLTAX_VERSION: DEMO ? '1.0.0' : 'dev', // updates are offered only to release versions
    CLOUD_COMMAND_PUBKEY_PEM: cloudKey ? cloudKey.publicKey.export({ type: 'spki', format: 'pem' }).toString() : null,
    UPDATE_DIR: `${dataDir}update-request`,
    TIME_SYNC_FILE: process.platform === 'win32' ? 'C:\\Windows' : '/',
    UI_DIR: fileURLToPath(new URL('../../../frontend/web/out/', import.meta.url)),
    // Household accounts: invitation links open this hub; email goes only to DEV_SMTP_URL (e.g. a local
    // Mailpit), never to a real provider unless you point it there.
    CUSTOMER_ORIGIN: `http://localhost:${PORT}`,
    ALLOW_INSECURE_HTTP: true,
    ...(SMTP_URL ? { CUSTOMER_SMTP_URL: SMTP_URL, CUSTOMER_SMTP_FROM: 'home@voltex.local' } : {}),
  },
  { logger: { level: 'warn' } },
);
await hub.start();
await hub.app.listen({ host: '127.0.0.1', port: PORT });

if (cloudKey) {
  // Plays the admin portal's "Generate homeowner code" (the product shows it to the admin only).
  if (!hub.customers.claimed) {
    const { challenge } = hub.customers.ready();
    const issued = Date.now();
    const out = hub.customers.onboard({ v: 1, type: 'customer.onboard', envelopeId: randomUUID(), hubId: HUB_ID, issuedAt: issued, expiresAt: issued + 60_000, actor: { staffId: randomUUID(), role: 'PLATFORM_SUPER_ADMIN', displayName: 'Demo admin' }, email: process.env.DEV_OWNER_EMAIL ?? 'owner@voltex.local', challenge });
    if (out.result.ok) console.log(`demo homeowner code for ${out.result.email}: ${out.result.code.slice(0, 5)}-${out.result.code.slice(5)} (10 minutes)`);
  }
  const actor = (role, displayName) => ({ staffId: randomUUID(), role, displayName });
  const send = (body, who) => {
    const now = Date.now();
    const payload = JSON.stringify({ v: 1, envelopeId: randomUUID(), hubId: HUB_ID, issuedAt: now, expiresAt: now + 60_000, actor: who, ...body });
    hub.grants.handle({ payload, sig: sign(null, Buffer.from(payload), cloudKey.privateKey).toString('base64') });
  };
  const now = Date.now();
  send(
    {
      type: 'grant.request',
      grant: {
        grantId: randomUUID(),
        deviceIds: ['kitchen'],
        actions: ['device.command', 'diagnostics.read'],
        reason: 'Customer reports the kitchen lights do not respond',
        ticketRef: 'VTX-1042',
        startsAt: now,
        endsAt: now + 60 * 60_000,
      },
    },
    actor('PLATFORM_SUPPORT', 'Priya (VOLTEX support)'),
  );
  send({ type: 'hub.update', rolloutId: randomUUID(), version: '1.1.0' }, actor('PLATFORM_SUPER_ADMIN', 'Release team'));
  console.log('demo: a support request and a hub update offer are waiting for the owner');
}

console.log(`\nVOLTAX dev hub: http://localhost:${PORT}\n`);
