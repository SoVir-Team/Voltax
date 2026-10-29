// Persistent Windows installation of the real services; no fake devices or staff accounts.
// First build the workspaces, then: node tools/run-local.mjs --admin-email you@example.com
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = join(root, '.secrets', 'local');
const stateFile = join(dir, 'installation.json');
const ports = { postgres: 55432, mqtt: 18883, cloudMqtt: 18884, home: 8088, admin: 8098 };
const homeUrl = `http://localhost:${ports.home}`;
const adminUrl = `http://localhost:${ports.admin}`;
const adminOrigin = process.env.LOCAL_ADMIN_ORIGIN ?? adminUrl;
const customerOrigin = process.env.LOCAL_CUSTOMER_ORIGIN ?? homeUrl; // invitation links open the customer app
const pgBin = 'C:/Program Files/PostgreSQL/18/bin';
const mqttBin = 'C:/Program Files/mosquitto';
const { values } = parseArgs({ options: { 'admin-email': { type: 'string' } } });
const email = values['admin-email']?.trim().toLowerCase();
const secret = () => randomBytes(32).toString('hex');
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
let state;
let hub;
let cloud;
const brokers = [];
let pgStarted = false;
let closing = false;
const logFiles = [];

function redact(message) {
  for (const value of Object.values(state ?? {})) {
    if (typeof value === 'string' && value.length > 20) message = message.replaceAll(value, '[private]');
  }
  return message;
}

function run(exe, args, extra = {}) {
  const result = spawnSync(exe, args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120_000, ...extra });
  if (result.error || result.status !== 0) throw new Error(redact(`${exe.split(/[\\/]/).at(-1)}: ${result.error?.message ?? result.stderr ?? 'failed'}`));
  return result.stdout;
}

async function waitFor(check, description, seconds = 30) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out: ${description}. Check .secrets/local/mosquitto.log.`);
}

async function requireFreePort(port) {
  await new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once('error', () => reject(new Error(`Port ${port} is occupied. Stop the earlier local launch before starting another.`)));
    socket.listen(port, '127.0.0.1', () => socket.close(resolve));
  });
}

async function stop() {
  if (closing) return;
  closing = true;
  await hub?.stop();
  await cloud?.close();
  for (const broker of brokers) {
    if (broker.exitCode !== null) continue;
    const stopped = new Promise((resolve) => broker.once('exit', resolve));
    broker.kill();
    await stopped;
  }
  if (pgStarted) run(join(pgBin, 'pg_ctl.exe'), ['-D', join(dir, 'postgres'), '-m', 'fast', '-w', 'stop']);
  for (const fd of logFiles) closeSync(fd);
}

async function main() {
  assert.equal(process.platform, 'win32', 'This launcher uses the installed Windows PostgreSQL and Mosquitto binaries.');
  assert(email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'Pass --admin-email with your real account email.');
  assert([adminUrl, 'http://localhost:3001'].includes(adminOrigin), 'LOCAL_ADMIN_ORIGIN must be the local portal URL or http://localhost:3001 for Next.js hot reload.');
  const identity = run('whoami.exe', ['/user', '/fo', 'csv', '/nh']);
  assert(!/codexsandbox/i.test(identity), 'Run this launcher in your normal Windows PowerShell account; PostgreSQL cannot start in the Codex sandbox.');
  const sid = identity.match(/S-\d-(?:\d+-)+\d+/)?.[0];
  assert(sid, 'Could not identify the Windows account for private-file permissions.');
  for (const file of ['backend/cloud/dist/cloud.js', 'backend/hub/dist/hub.js', 'frontend/web/out/index.html', 'frontend/admin/out/index.html']) {
    assert(existsSync(join(root, file)), 'Run npm install and npm run build from the repository root first.');
  }
  for (const file of [join(pgBin, 'initdb.exe'), join(pgBin, 'pg_ctl.exe'), join(mqttBin, 'mosquitto.exe'), join(mqttBin, 'mosquitto_passwd.exe')]) {
    assert(existsSync(file), `Missing prerequisite: ${file}`);
  }
  await Promise.all(Object.values(ports).map(requireFreePort));
  mkdirSync(dir, { recursive: true });
  run('icacls.exe', [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`]);
  if (existsSync(stateFile)) {
    state = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.equal(state.adminEmail, email, 'This installation already belongs to another admin email; its account was not changed.');
  } else {
    state = { adminEmail: email, pgPassword: secret(), ownerPassword: secret(), appPassword: secret(), dataKey: secret(), mqttPassword: secret(), servicePassword: secret(), hubId: 'voltax-local-hub' };
    save();
  }
  for (const name of ['hub', 'backups', 'broker', 'cloud-broker', 'update-request']) mkdirSync(join(dir, name), { recursive: true });
  for (const name of ['command', 'audit']) {
    const file = join(dir, `${name}.key`);
    if (!existsSync(file)) {
      const pair = generateKeyPairSync('ed25519');
      writeFileSync(file, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
      writeFileSync(`${file}.pub`, pair.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    }
  }
  const data = join(dir, 'postgres');
  if (!existsSync(join(data, 'PG_VERSION'))) {
    const passwordFile = join(dir, 'init-password');
    writeFileSync(passwordFile, state.pgPassword, { mode: 0o600 });
    try {
      run(join(pgBin, 'initdb.exe'), ['-D', data, '-U', 'postgres', '--auth=scram-sha-256', `--pwfile=${passwordFile}`, '-E', 'UTF8', '--no-locale', '--no-instructions']);
    } finally {
      unlinkSync(passwordFile);
    }
  }
  run(join(pgBin, 'pg_ctl.exe'), ['-D', data, '-l', join(dir, 'postgres.log'), '-o', `-p ${ports.postgres} -c listen_addresses=127.0.0.1`, '-w', 'start'], { stdio: 'ignore' });
  pgStarted = true;

  const { pgDb, migrate } = await import('../backend/cloud/dist/db.js');
  const dbUrl = (role, password, database = 'voltax') => `postgresql://${role}:${password}@127.0.0.1:${ports.postgres}/${database}`;
  const bootstrapDb = pgDb(dbUrl('postgres', state.pgPassword, 'postgres'));
  try {
    for (const [role, password] of [['voltax_owner', state.ownerPassword], ['voltax_app', state.appPassword]]) {
      assert(/^[a-f0-9]{64}$/.test(password));
      if (!(await bootstrapDb.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).length) {
        // Role DDL cannot bind a password parameter; format quotes the bound value server-side.
        await bootstrapDb.tx(async (t) => {
          await t.query("SELECT set_config('voltax.setup_password', $1, true)", [password]);
          await t.exec(`DO $$ BEGIN EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', '${role}', current_setting('voltax.setup_password')); END $$;`);
        });
      }
    }
    if (!(await bootstrapDb.query("SELECT 1 FROM pg_database WHERE datname = 'voltax'")).length) await bootstrapDb.exec('CREATE DATABASE voltax OWNER voltax_owner');
  } finally {
    await bootstrapDb.close();
  }
  const ownerDb = pgDb(dbUrl('voltax_owner', state.ownerPassword));
  try { await migrate(ownerDb); } finally { await ownerDb.close(); }

  const { createCloud } = await import('../backend/cloud/dist/cloud.js');
  const appDb = pgDb(dbUrl('voltax_app', state.appPassword));
  cloud = await createCloud({
    db: appDb,
    dataKey: Buffer.from(state.dataKey, 'hex'),
    commandKeyPem: readFileSync(join(dir, 'command.key'), 'utf8'),
    auditKeyPem: readFileSync(join(dir, 'audit.key'), 'utf8'),
    migrate: false,
    api: { cookieSecure: false, publicOrigin: adminOrigin, uiDir: join(root, 'frontend/admin/out') },
    server: { logger: { level: 'warn' } },
    broker: { url: `mqtt://127.0.0.1:${ports.cloudMqtt}`, password: state.servicePassword },
  });
  let admin = (await cloud.staff.list()).find((s) => s.email === email);
  if (!admin) {
    const created = await cloud.staff.bootstrapAdmin(email, email.split('@')[0]);
    admin = created.staff;
    state.setupToken = created.setupToken;
    state.setupCreatedAt = Date.now();
    save();
  }
  assert.equal(admin.role, 'PLATFORM_SUPER_ADMIN');
  if (!state.homeId) {
    const home = await cloud.homes.create({ name: 'My Home', ownerContact: email }, admin.staffId);
    state.homeId = home.homeId;
    save();
  }
  if (!state.hubCloudPassword) {
    const enrolled = await cloud.homes.registerHub(state.homeId, state.hubId, admin.staffId);
    state.hubCloudPassword = enrolled.brokerPassword;
    save();
  }

  const localAcl = readFileSync(join(root, 'deploy/pi/mosquitto/acl.template'), 'utf8').replaceAll('__HUB_ID__', state.hubId);
  const cloudAcl = `user voltax-cloud-service\ntopic read voltax-cloud/+/up\ntopic read voltax-cloud/+/status\ntopic write voltax-cloud/+/down\n\nuser ${state.hubId}\ntopic write voltax-cloud/${state.hubId}/up\ntopic write voltax-cloud/${state.hubId}/status\ntopic read voltax-cloud/${state.hubId}/down\n`;
  const path = (p) => p.replaceAll('\\', '/');
  let brokerError;
  // Separate brokers are necessary: the production local/cloud links use the same MQTT client ID.
  for (const [name, port, acl, users] of [
    ['broker', ports.mqtt, localAcl, [['hub', state.mqttPassword]]],
    ['cloud-broker', ports.cloudMqtt, cloudAcl, [['voltax-cloud-service', state.servicePassword], [state.hubId, state.hubCloudPassword]]],
  ]) {
    const folder = join(dir, name);
    const passwordFile = join(folder, 'accounts');
    if (!existsSync(passwordFile)) {
      for (const [i, [user, password]] of users.entries()) run(join(mqttBin, 'mosquitto_passwd.exe'), ['-H', 'sha512-pbkdf2', ...(i === 0 ? ['-c'] : []), '-b', passwordFile, user, password]);
    }
    const configFile = join(folder, 'mosquitto.conf');
    writeFileSync(join(folder, 'acl'), acl);
    writeFileSync(configFile, `listener ${port} 127.0.0.1\nallow_anonymous false\npassword_file ${path(passwordFile)}\nacl_file ${path(join(folder, 'acl'))}\npersistence true\npersistence_location ${path(folder)}/\nlog_dest stdout\n`);
    const fd = openSync(join(dir, `${name}.log`), 'a');
    logFiles.push(fd);
    const broker = spawn(join(mqttBin, 'mosquitto.exe'), ['-c', configFile], { cwd: root, windowsHide: true, stdio: ['ignore', fd, fd] });
    broker.once('error', (e) => { brokerError = e; });
    brokers.push(broker);
  }
  await cloud.app.listen({ host: '127.0.0.1', port: ports.admin });
  await cloud.start();
  await waitFor(() => { if (brokerError) throw brokerError; return cloud.broker.connected; }, 'cloud MQTT connection');

  const mailFile = join(dir, 'customer-mail.json');
  const customerMail = existsSync(mailFile) ? JSON.parse(readFileSync(mailFile, 'utf8')) : {};
  if (customerMail.user && customerMail.password) {
    const smtpUrl = new URL('smtps://smtp.gmail.com:465');
    smtpUrl.username = customerMail.user; smtpUrl.password = customerMail.password.replace(/\s/g, '');
    customerMail.smtpUrl = smtpUrl.toString();
  }
  const { createHub } = await import('../backend/hub/dist/hub.js');
  hub = await createHub({
    CUSTOMER_ORIGIN: customerOrigin, ALLOW_INSECURE_HTTP: true,
    CUSTOMER_SMTP_URL: customerMail.smtpUrl ?? process.env.CUSTOMER_SMTP_URL, CUSTOMER_SMTP_FROM: customerMail.from ?? process.env.CUSTOMER_SMTP_FROM,
    HUB_ID: state.hubId, HUB_NAME: 'My Home', DB_PATH: join(dir, 'hub', 'hub.db'), BACKUP_DIR: join(dir, 'backups'),
    MQTT_URL: `mqtt://127.0.0.1:${ports.mqtt}`, MQTT_USERNAME: 'hub', MQTT_PASSWORD: state.mqttPassword,
    TZ: 'Asia/Kolkata', VOLTAX_VERSION: '0.1.0', TIME_SYNC_FILE: join(dir, 'time-synchronized'),
    UI_DIR: join(root, 'frontend/web/out'), UPDATE_DIR: join(dir, 'update-request'),
    CLOUD_URL: `mqtt://127.0.0.1:${ports.cloudMqtt}`, CLOUD_PASSWORD: state.hubCloudPassword,
    CLOUD_COMMAND_PUBKEY_PEM: readFileSync(join(dir, 'command.key.pub'), 'utf8'), TELEMETRY_INTERVAL_MS: 5000,
  }, { logger: { level: 'warn' } });
  await hub.start();
  await hub.app.listen({ host: '127.0.0.1', port: ports.home });
  await waitFor(() => hub.mqtt.connected, 'local MQTT connection');
  await waitFor(async () => Boolean((await cloud.homes.get(state.homeId)).hub?.online), 'real hub telemetry reaching PostgreSQL');

  const [rights] = await appDb.query("SELECT has_table_privilege(current_user, 'audit_log', 'UPDATE') AS can_update");
  assert.equal(rights.can_update, false, 'The app database role must not rewrite audit records.');
  for (const url of [homeUrl, adminUrl]) assert.equal((await fetch(`${url}/api/v1/health`)).status, 200);
  assert.equal((await fetch(`${adminUrl}/api/v1/staff`)).status, 401);
  console.log(`\nVOLTEX real local services (persistent data; no simulated devices)\nCustomer: ${homeUrl}\nHomeowner setup: generate the initial code in Admin > Homes > My Home > Homeowner setup\nAdmin: ${adminOrigin}\nAdmin email: ${email}`);
  if (!admin.setupComplete) {
    const setupUrl = state.setupToken ? `${adminOrigin}/setup/?token=${encodeURIComponent(state.setupToken)}` : `${adminOrigin}/setup/`;
    writeFileSync(join(dir, 'admin-setup-url.txt'), setupUrl + '\n', { mode: 0o600 });
    console.log(`Finish password setup:\n${setupUrl}`);
  }
  console.log(`Staff: create accounts under Admin > Staff; each person uses their setup link.\nData and keys: ${dir}\nChecks passed: real PostgreSQL, restricted DB role, MQTT, hub-to-cloud telemetry, health and unauthorized-access refusal.\nLocal loopback HTTP only; not a public production deployment.\nNo device simulations, fake approvals, trusted clock marker, or real update runner. Customer email requires valid SMTP configuration. Hardware and external services need separate configuration.\nPress Ctrl+C to stop; your data is retained.\n`);
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop().then(() => process.exit(0), (e) => { console.error(redact(e.message)); process.exit(1); }); });
main().catch(async (e) => {
  console.error(redact(e.message));
  try { await stop(); } catch (cleanup) { console.error(redact(cleanup.message)); }
  process.exitCode = 1;
});
