// Development only: runs the real cloud on an in-memory database (PGlite) over plain HTTP on
// localhost and serves the company portal from frontend/admin/out (npm run build -w frontend/admin).
//   npm run build -w backend/cloud && node backend/cloud/dev/dev-cloud.mjs --demo   then open http://localhost:8090
// Everything is throwaway and made at start: data key, command/audit/release keys and staff accounts.
// Nothing is saved except backend/cloud/.dev-data/ (git-ignored): the demo accounts and a signed
// sample release to try the upload screen.
//
// --demo  adds homes, hubs and staff, and plays the hubs: they answer diagnostics, commands and
//         update offers, and the "owner" approves support requests after a few seconds. On a real hub
//         the owner decides in their app; this simulation exists only to click through the portal.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCloud } from '../dist/cloud.js';
import { pgliteDb } from '../dist/db.js';

const dataDir = fileURLToPath(new URL('../.dev-data/', import.meta.url));
const accountsFile = `${dataDir}dev-accounts.json`;

const DEMO = process.argv.includes('--demo');
const PORT = Number(process.env.PORT ?? 8090);
const uiDir = fileURLToPath(new URL('../../../frontend/admin/out/', import.meta.url));
mkdirSync(dataDir, { recursive: true });

const pem = () => generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

// A minisign-format release key, so the release screens work (production pins the real public key).
const releaseKey = generateKeyPairSync('ed25519');
const releaseKeyId = randomBytes(8);
const releasePub = `untrusted comment: minisign public key (dev)\n${Buffer.concat([Buffer.from('Ed'), releaseKeyId, Buffer.from(releaseKey.publicKey.export({ format: 'jwk' }).x, 'base64url')]).toString('base64')}\n`;
const minisign = (message, comment) => {
  const sig = sign(null, createHash('blake2b512').update(message).digest(), releaseKey.privateKey);
  const global = sign(null, Buffer.concat([sig, Buffer.from(comment)]), releaseKey.privateKey);
  return ['untrusted comment: signature from minisign secret key', Buffer.concat([Buffer.from('ED'), releaseKeyId, sig]).toString('base64'), `trusted comment: ${comment}`, global.toString('base64'), ''].join('\n');
};
const hubRelease = (version) => {
  const manifest = JSON.stringify({
    version,
    hubImage: `ghcr.io/voltex/hub@sha256:${'a'.repeat(64)}`,
    mosquittoImage: `eclipse-mosquitto@sha256:${'b'.repeat(64)}`,
    composeSha256: 'c'.repeat(64),
    builtAt: new Date().toISOString(),
  });
  return { manifest, signature: minisign(manifest, `voltax hub ${version}`) };
};

let cloud;
const later = (ms, hubId, msg) => setTimeout(() => void cloud.route(hubId, msg).catch((err) => console.warn('dev hub:', err.message)), ms);

// Simulated hubs (DEMO): answer the way backend/hub does when the owner says yes.
const transport = {
  async publish(hubId, signed) {
    const e = JSON.parse(signed.payload);
    console.log(`dev hub ${hubId} <- ${e.type}`);
    switch (e.type) {
      case 'grant.request':
        // Simulated owner approval. A real hub shows the request in the owner's app.
        return later(4000, hubId, { type: 'grant.status', grantId: e.grant.grantId, status: 'active', at: Date.now(), startNoticeAt: Date.now() });
      case 'grant.revoke':
        return later(300, hubId, { type: 'grant.status', grantId: e.grantId, status: e.outcome === 'completed' ? 'completed' : 'revoked', at: Date.now(), reason: e.reason });
      case 'command':
        return later(500, hubId, { type: 'command.result', commandId: e.commandId, grantId: e.grantId, status: 'confirmed' });
      case 'diagnostics.request':
        return later(300, hubId, {
          type: 'diagnostics.result',
          requestId: e.requestId,
          grantId: e.grantId,
          diagnostics: {
            version: '1.0.0',
            uptime: 86_400 * 3,
            db: 'up',
            mqtt: 'up',
            timeSynced: true,
            devices: [
              { deviceId: 'kitchen', online: true, lastSeen: Date.now() },
              { deviceId: 'porch', online: false, lastSeen: Date.now() - 3_600_000 },
            ],
            commandsLast24h: { confirmed: 41, failed: 1, expired: 0 },
            eventLogSeq: 1234,
          },
        });
      case 'activity.request':
        return later(300, hubId, {
          type: 'activity.result',
          requestId: e.requestId,
          grantId: e.grantId,
          events: [
            { seq: 1, type: 'device.online', createdAt: Date.now() - 600_000, payload: {} },
            { seq: 2, type: 'command.confirmed', createdAt: Date.now() - 300_000, payload: {} },
          ],
        });
      case 'customer.onboard': {
        // Like backend/hub: a one-time code for the invited email, then a fresh challenge (each works once).
        const code = randomBytes(8).toString('hex').toUpperCase().slice(0, 10);
        later(300, hubId, { type: 'customer.onboard.result', requestId: e.envelopeId, result: { ok: true, code, expiresAt: Date.now() + 600_000, email: e.email } });
        return later(400, hubId, { type: 'customer.ready', challenge: randomBytes(32).toString('base64url'), claimed: false });
      }
      case 'hub.update':
        later(1500, hubId, { type: 'update.status', rolloutId: e.rolloutId, state: 'requested', version: e.version });
        return later(6000, hubId, { type: 'update.status', rolloutId: e.rolloutId, state: 'done', version: e.version });
      default:
        return;
    }
  },
};

const consoleEmail = {
  async send(m) {
    console.log(`dev email to ${m.to}: ${m.subject}`);
  },
};

cloud = await createCloud({
  db: await pgliteDb(),
  dataKey: randomBytes(32),
  commandKeyPem: pem(),
  auditKeyPem: pem(),
  releasePublicKey: releasePub,
  api: { cookieSecure: false, uiDir },
  server: { logger: { level: 'warn' } },
  ...(DEMO ? { transport, email: consoleEmail } : {}),
});

const inject = async (method, url, body, cookie) => {
  const res = await cloud.app.inject({ method, url, payload: body, headers: cookie ? { cookie } : {} });
  if (res.statusCode >= 300) throw new Error(`${method} ${url}: ${res.statusCode} ${res.body}`);
  return { body: res.json(), cookie: String(res.headers['set-cookie'] ?? '').split(';')[0] };
};

// Accounts made the way staff make them: setup link -> password.
async function account(email, name, role) {
  const { staff, setupToken } = role === 'PLATFORM_SUPER_ADMIN' ? await cloud.staff.bootstrapAdmin(email, name) : await cloud.staff.create({ email, displayName: name, role }, 'cli');
  const password = randomBytes(12).toString('base64url');
  await inject('POST', '/api/v1/auth/setup', { token: setupToken, password });
  return { staffId: staff?.staffId, email, role, password };
}

let setupLink = null;
if (DEMO) {
  const admin = await account('admin@voltex.test', 'Asha Admin', 'PLATFORM_SUPER_ADMIN');
  const support = await account('support@voltex.test', 'Sam Support', 'PLATFORM_SUPPORT');
  const installer = await account('installer@voltex.test', 'Ira Installer', 'INSTALLER');
  writeFileSync(accountsFile, JSON.stringify([admin, support, installer], null, 2));

  const telemetry = (version, devices) => ({ version, uptime: 3600, db: 'up', mqtt: 'up', timeSynced: true, devices, update: { state: 'idle' }, at: Date.now() });
  const homes = [
    ['Sharma residence', 'sharma-hub', '1.0.0', ['kitchen', 'porch', 'living-room']],
    ['Lake view villa', 'lakeview-hub', '1.0.0', ['garage', 'bedroom']],
    ['Office 4B', 'office4b-hub', '0.9.0', ['lobby']],
  ];
  const ids = [];
  for (const [name, hubId, version, devices] of homes) {
    const { homeId } = await cloud.homes.create({ name, ownerContact: `${hubId}@owner.test` }, admin.staffId);
    await cloud.homes.registerHub(homeId, hubId, admin.staffId);
    await cloud.route(hubId, { type: 'telemetry', telemetry: telemetry(version, devices.map((deviceId, i) => ({ deviceId, online: i !== 1 }))) });
    ids.push(homeId);
  }
  await cloud.db.query("UPDATE hubs SET last_seen_at = $1 WHERE hub_id = 'office4b-hub'", [Date.now() - 6 * 3_600_000]);
  // Online hubs keep reporting, as real ones do with their telemetry: Sharma has no homeowner yet
  // (the admin can generate the first code), Lake view already has one.
  const report = () => {
    for (const [, hubId, version, devices] of homes.slice(0, 2)) {
      void cloud.route(hubId, { type: 'telemetry', telemetry: telemetry(version, devices.map((deviceId, i) => ({ deviceId, online: i !== 1 }))) });
      void cloud.route(hubId, { type: 'customer.ready', challenge: randomBytes(32).toString('base64url'), claimed: hubId === 'lakeview-hub' });
    }
  };
  report();
  setInterval(report, 60_000);
  for (const id of ids.slice(0, 2)) await cloud.homes.assign({ staffId: support.staffId, homeId: id, expiresAt: null }, admin.staffId);
  await cloud.homes.assign({ staffId: installer.staffId, homeId: ids[2], expiresAt: null }, admin.staffId);

  const r = hubRelease('1.1.0');
  await cloud.fleet.registerRelease({ kind: 'hub', ...r, notes: 'Dev sample release' }, admin.staffId);
  const next = hubRelease('1.2.0');
  writeFileSync(`${dataDir}release-1.2.0.json`, next.manifest);
  writeFileSync(`${dataDir}release-1.2.0.json.minisig`, next.signature);

  const pending = await cloud.staff.create({ email: 'new.hire@voltex.test', displayName: 'New Hire', role: 'PLATFORM_SUPPORT' }, admin.staffId);
  setupLink = `http://localhost:${PORT}/setup/?token=${pending.setupToken}`;
}

await cloud.app.listen({ host: '127.0.0.1', port: PORT });
await cloud.start();
console.log(`dev cloud: http://localhost:${PORT}  (portal from ${uiDir})`);
if (DEMO) {
  console.log(`demo accounts (email and passwords): ${accountsFile}`);
  console.log(`setup link for a new staff member: ${setupLink}`);
}
