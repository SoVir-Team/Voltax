// Load test (docs/testing/load-test-spec.md): 120 real hubs × 10 simulated devices, 300 portal users,
// telemetry every 30 s, against the real cloud on PostgreSQL 18 + EMQX + Mailpit, all on this machine.
//   npm run build
//   node tools/loadtest/run.mjs --minutes 60 --warmup 5      (the measured run)
//   node tools/loadtest/run.mjs --minutes 2 --warmup 1       (smoke test: written to tools/loadtest/.out)
// Throwaway everything: a temp PostgreSQL cluster (trust auth, 127.0.0.1), fresh keys, generated
// passwords, containers removed at the end. Nothing here is a real credential.
import { fork, spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, release, tmpdir, totalmem, type } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { MAILPIT_IMAGE, EMQX_IMAGE, ROOT, docker, emqxConfig, freePort, load, sleep, summarise, until } from './lib.mjs';

const { values: args } = parseArgs({
  options: {
    minutes: { type: 'string', default: '60' },
    warmup: { type: 'string', default: '5' },
    hubs: { type: 'string', default: '120' },
    users: { type: 'string', default: '300' },
    workers: { type: 'string', default: '4' },
  },
});
const MINUTES = Number(args.minutes);
const WARMUP = Number(args.warmup);
const HUBS = Number(args.hubs);
const USERS = Number(args.users);
const WORKERS = Number(args.workers);
const OFFICIAL = MINUTES >= 60 && WARMUP >= 5 && HUBS === 120 && USERS === 300;
const DEVICES_PER_HUB = 10;
const TELEMETRY_MS = 30_000;

for (const f of ['backend/cloud/dist/main.js', 'backend/hub/dist/hub.js', 'shared/contracts/dist/index.js']) {
  if (!existsSync(join(ROOT, f))) throw new Error(`${f} missing: run npm run build first`);
}
if (docker(['info', '--format', '{{.ServerVersion}}']).status !== 0) throw new Error('Docker engine not reachable: start Docker Desktop');

const say = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const work = mkdtempSync(join(tmpdir(), 'voltex-load-'));
const cleanups = [];
const cleanup = async () => {
  for (const fn of cleanups.reverse()) await Promise.resolve(fn()).catch(() => {});
  rmSync(work, { recursive: true, force: true });
};
process.on('SIGINT', () => void cleanup().then(() => process.exit(130)));

const env = {
  startedAt: new Date().toISOString(),
  commit: spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(),
  os: `${type()} ${release()}`,
  cpu: `${cpus()[0]?.model} (${cpus().length} logical)`,
  ramGb: Math.round(totalmem() / 2 ** 30),
  node: process.version,
  docker: docker(['version', '--format', '{{.Server.Version}}']).stdout.trim(),
  emqx: EMQX_IMAGE,
  mailpit: MAILPIT_IMAGE,
  workers: WORKERS,
};

try {
  // --- PostgreSQL 18: throwaway cluster (same approach as backend/cloud/test-pg/run.mjs) ----------
  const bin = process.env.PG_BIN ?? (process.platform === 'win32' ? 'C:\\Program Files\\PostgreSQL\\18\\bin' : '');
  const exe = (n) => (bin ? join(bin, process.platform === 'win32' ? `${n}.exe` : n) : n);
  const pgPort = await freePort();
  const pgData = join(work, 'pg');
  const init = spawnSync(exe('initdb'), ['-D', pgData, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--no-instructions'], { encoding: 'utf8' });
  if (init.status !== 0) throw new Error(`initdb failed: ${init.stderr}`);
  const sockets = process.platform === 'win32' ? '' : ` -k ${work}`;
  const pgStart = spawnSync(exe('pg_ctl'), ['-D', pgData, '-l', join(work, 'pg.log'), '-o', `-p ${pgPort} -c listen_addresses=127.0.0.1 -c max_connections=200${sockets}`, '-w', 'start'], { stdio: 'ignore', timeout: 60_000 });
  if (pgStart.status !== 0) throw new Error(`pg_ctl start failed:\n${readFileSync(join(work, 'pg.log'), 'utf8')}`);
  cleanups.push(() => spawnSync(exe('pg_ctl'), ['-D', pgData, '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' }));
  const pgUrl = (user, db = 'voltex') => `postgres://${user}@127.0.0.1:${pgPort}/${db}`;
  const admin = new pg.Client({ connectionString: pgUrl('postgres', 'postgres') });
  await admin.connect();
  env.postgres = (await admin.query('SHOW server_version')).rows[0].server_version;
  await admin.query('CREATE ROLE voltax_owner LOGIN; CREATE ROLE voltax_app LOGIN; CREATE ROLE voltax_audit_reader LOGIN;');
  await admin.query('CREATE DATABASE voltex OWNER voltax_owner');
  await admin.end();
  say(`PostgreSQL ${env.postgres} on :${pgPort}`);

  // --- keys and secrets for this run only ---------------------------------------------------------
  const pem = () => generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  writeFileSync(join(work, 'command.key'), pem());
  writeFileSync(join(work, 'audit.key'), pem());
  const servicePassword = randomBytes(24).toString('hex');
  const brokerSecret = randomBytes(24).toString('hex');
  const [httpPort, internalPort, brokerPort, smtpPort, mailHttpPort] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
  const tag = randomBytes(3).toString('hex');

  // --- Mailpit (owner notices) and EMQX (cloud broker, authn/authz through the cloud) -------------
  const mail = `voltex-load-mailpit-${tag}`;
  let r = docker(['run', '-d', '--rm', '--name', mail, '-p', `127.0.0.1:${smtpPort}:1025`, '-p', `127.0.0.1:${mailHttpPort}:8025`, MAILPIT_IMAGE, '--smtp-allowed-recipients', '@example\\.test$', '--max', '1000']);
  if (r.status !== 0) throw new Error(`mailpit: ${r.stderr}`);
  cleanups.push(() => docker(['rm', '-f', mail]));

  // --- the cloud, as in production: migrations by the owner role, the app as voltax_app -----------
  const cloudEnv = {
    ...process.env,
    DATABASE_URL: pgUrl('voltax_app'),
    CLOUD_DATA_KEY: randomBytes(32).toString('hex'),
    HOST: '127.0.0.1',
    PORT: String(httpPort),
    COOKIE_SECURE: 'false', // plain HTTP on loopback (TLS is out of scope, see the spec)
    TRUST_PROXY: '127.0.0.1', // as behind Caddy: each user's address arrives in X-Forwarded-For
    COMMAND_KEY_FILE: join(work, 'command.key'),
    AUDIT_KEY_FILE: join(work, 'audit.key'),
    RELEASE_PUBKEY_FILE: join(work, 'no-release.pub'),
    CLOUD_BROKER_URL: `mqtt://127.0.0.1:${brokerPort}`,
    CLOUD_BROKER_PASSWORD: servicePassword,
    BROKER_PUBLIC_URL: `mqtt://127.0.0.1:${brokerPort}`,
    INTERNAL_HOST: '127.0.0.1',
    INTERNAL_PORT: String(internalPort),
    BROKER_AUTH_SECRET: brokerSecret,
    SMTP_URL: `smtp://127.0.0.1:${smtpPort}`,
    SMTP_FROM: 'VOLTEX <notices@voltex.example.test>',
    LOG_LEVEL: 'info',
  };
  const cli = (argv, user) => spawnSync(process.execPath, [join(ROOT, 'backend/cloud/dist/cli.js'), ...argv], { encoding: 'utf8', env: { ...cloudEnv, DATABASE_URL: pgUrl(user) } });
  r = cli(['migrate'], 'voltax_owner');
  if (r.status !== 0) throw new Error(`migrate: ${r.stderr}`);
  r = cli(['bootstrap-admin', '--email', 'ops@example.test', '--name', 'Ops (load test)'], 'voltax_app');
  if (r.status !== 0) throw new Error(`bootstrap-admin: ${r.stderr}`);
  const opsToken = r.stdout.trim().split('#').pop();

  mkdirSync(join(ROOT, 'tools/loadtest/.out'), { recursive: true });
  const cloudLog = createWriteStream(join(ROOT, 'tools/loadtest/.out/cloud.log'));
  // Supervised like the production container (restart policy): EMQX checks its auth webhook every
  // 15 s, so on a cold start the cloud can give up on the broker once before EMQX sees its auth API.
  // Every restart is counted and reported; one during the measured window shows up as errors too.
  let cloud;
  let shuttingDown = false;
  const cloudRestarts = [];
  const startCloud = () => {
    cloud = spawn(process.execPath, [join(ROOT, 'backend/cloud/dist/main.js')], { env: cloudEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    cloud.stdout.pipe(cloudLog, { end: false });
    cloud.stderr.pipe(cloudLog, { end: false });
    cloud.once('exit', (code) => {
      if (shuttingDown) return;
      cloudRestarts.push({ at: new Date().toISOString(), code });
      say(`cloud exited (${code}); restarting`);
      setTimeout(startCloud, 2000);
    });
  };
  startCloud();

  // EMQX after the cloud: its auth webhook (the cloud's internal API) must answer when EMQX starts.
  const emqxConf = join(work, 'emqx.conf');
  writeFileSync(emqxConf, emqxConfig(`http://host.docker.internal:${internalPort}`, brokerSecret));
  const emqx = `voltex-load-emqx-${tag}`;
  const r2 = docker(['run', '-d', '--rm', '--name', emqx, '--add-host', 'host.docker.internal:host-gateway', '-p', `127.0.0.1:${brokerPort}:1883`, '-v', `${emqxConf}:/opt/emqx/etc/emqx.conf:ro`, EMQX_IMAGE]);
  if (r2.status !== 0) throw new Error(`emqx: ${r2.stderr}`);
  cleanups.push(() => docker(['rm', '-f', emqx]));
  await until(async () => docker(['exec', emqx, 'emqx', 'ctl', 'status']).stdout.includes('is started'), 'EMQX', 120_000, 1000);
  say(`EMQX ${EMQX_IMAGE} on :${brokerPort}, Mailpit SMTP :${smtpPort}`);
  cleanups.push(() => {
    shuttingDown = true;
    cloud.kill();
  });
  const cloudUrl = `http://127.0.0.1:${httpPort}`;
  const cloudLogFile = join(ROOT, 'tools/loadtest/.out/cloud.log');
  try {
    await until(async () => readFileSync(cloudLogFile, 'utf8').includes('connected to cloud broker') && (await fetch(`${cloudUrl}/api/v1/health`)).ok, 'cloud up and connected to EMQX', 120_000);
  } catch (err) {
    console.error(docker(['logs', '--tail', '40', emqx]).stdout);
    throw err;
  }
  say(`cloud on ${cloudUrl} (pid ${cloud.pid})`);

  // --- seeding through the API (not measured) ------------------------------------------------------
  const { totpAt, TOTP_STEP_MS } = await load('backend/cloud/dist/crypto.js');
  const step = () => Math.floor(Date.now() / TOTP_STEP_MS);
  let ipSeq = 0;
  const nextIp = () => {
    ipSeq++;
    return `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`;
  };
  const api = async (session, method, path, body) => {
    const res = await fetch(`${cloudUrl}${path}`, {
      method,
      headers: { 'x-forwarded-for': session.ip, ...(session.cookie ? { cookie: session.cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const cookies = res.headers.getSetCookie();
    if (cookies.length) session.cookie = cookies.map((c) => c.split(';')[0]).join('; ');
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
    return json;
  };
  /** First-time setup like a new staff member: password, TOTP enrolment. */
  const enrol = async (token) => {
    const s = { ip: nextIp(), cookie: null, password: randomBytes(18).toString('base64url') };
    await api(s, 'POST', '/api/v1/auth/setup', { token, password: s.password });
    s.secret = (await api(s, 'POST', '/api/v1/auth/totp/begin')).secret;
    s.lastStep = step();
    await api(s, 'POST', '/api/v1/auth/totp/confirm', { code: totpAt(s.secret, s.lastStep) });
    s.cookie = null;
    return s;
  };
  const ops = await enrol(opsToken);
  ops.email = 'ops@example.test';
  ops.lastStep += 1;
  if (ops.lastStep > step() + 1) await sleep(TOTP_STEP_MS);
  await api(ops, 'POST', '/api/v1/auth/login', { email: ops.email, password: ops.password, code: totpAt(ops.secret, ops.lastStep) });

  const pool = async (items, n, fn) => {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: n }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    }));
    return out;
  };

  say(`seeding ${HUBS} homes and hubs`);
  const homes = await pool([...Array(HUBS).keys()], 8, async (i) => {
    const n = String(i + 1).padStart(3, '0');
    const home = await api(ops, 'POST', '/api/v1/homes', { name: `Load home ${n}`, ownerContact: `owner-${n}@example.test` });
    const hubId = `load-hub-${n}`;
    const hub = await api(ops, 'POST', `/api/v1/homes/${home.homeId}/hub`, { hubId });
    return { homeId: home.homeId, hubId, name: `Load home ${n}`, brokerPassword: hub.brokerPassword, commandPublicKeyPem: hub.commandPublicKeyPem, devices: Array.from({ length: DEVICES_PER_HUB }, (_, d) => `relay-${String(d + 1).padStart(2, '0')}`) };
  });

  const roles = [
    ...Array(Math.round(USERS / 30)).fill('PLATFORM_SUPER_ADMIN'),
    ...Array(Math.round((USERS * 2) / 3)).fill('PLATFORM_SUPPORT'),
  ];
  while (roles.length < USERS) roles.push('INSTALLER');
  say(`seeding ${USERS} staff accounts (password + TOTP setup through the API, production scrypt cost)`);
  let sup = 0;
  let ins = 0;
  const users = await pool(roles, 8, async (role, i) => {
    const email = `${role.toLowerCase().replace(/_/g, '-')}-${i}@example.test`;
    const created = await api(ops, 'POST', '/api/v1/staff', { email, displayName: `${role} ${i}`, role });
    const s = await enrol(created.setupToken);
    let assigned = [];
    if (role === 'PLATFORM_SUPPORT') {
      const k = sup++;
      assigned = Array.from({ length: 6 }, (_, j) => homes[(k * 6 + j) % HUBS].homeId);
    } else if (role === 'INSTALLER') {
      const k = ins++;
      assigned = Array.from({ length: 4 }, (_, j) => homes[(k * 4 + j * 30 + 1) % HUBS].homeId);
    }
    assigned = [...new Set(assigned)];
    for (const homeId of assigned) await api(ops, 'POST', '/api/v1/assignments', { staffId: created.staff.staffId, homeId });
    return { email, password: s.password, secret: s.secret, lastStep: s.lastStep, ip: s.ip, role, staffId: created.staff.staffId, homes: assigned };
  });

  const plan = {
    cloudUrl,
    brokerUrl: `mqtt://127.0.0.1:${brokerPort}`,
    serviceUser: (await load('backend/cloud/dist/broker.js')).CLOUD_SERVICE_USER,
    servicePassword,
    commandPublicKeyPem: homes[0].commandPublicKeyPem,
    telemetryMs: TELEMETRY_MS,
    devicesPerHub: DEVICES_PER_HUB,
    hubs: homes,
    homes: homes.map((h) => ({ homeId: h.homeId, devices: h.devices })),
    homeById: Object.fromEntries(homes.map((h) => [h.homeId, { homeId: h.homeId, devices: h.devices }])),
    users,
    sampler: { email: ops.email, password: ops.password, secret: ops.secret, lastStep: ops.lastStep, ip: ops.ip, role: 'PLATFORM_SUPER_ADMIN', homes: [] },
  };
  const planFile = join(work, 'plan.json'); // throwaway credentials for this run only, deleted at the end
  writeFileSync(planFile, JSON.stringify(plan));

  // --- hubs ---------------------------------------------------------------------------------------
  say(`starting ${HUBS} hubs in ${WORKERS} worker processes`);
  const workers = [];
  const workerStats = [];
  await Promise.all(
    Array.from({ length: WORKERS }, (_, w) => {
      const child = fork(join(ROOT, 'tools/loadtest/hubs.mjs'), [planFile, String(w), String(WORKERS)], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      workers.push(child);
      cleanups.push(() => child.kill());
      child.on('message', (m) => {
        if (m.type === 'stats') workerStats.push(m.stats);
        if (m.type === 'log') say(`worker ${m.worker}: ${m.msg}`);
      });
      return new Promise((resolve, reject) => {
        child.on('message', (m) => m.type === 'ready' && (say(`worker ${w}: ${m.hubs} hubs, ${m.devices} devices ready`), resolve()));
        child.once('exit', (code) => reject(new Error(`hub worker ${w} exited (${code}) before it was ready`)));
      });
    }),
  );
  await until(async () => {
    const s = await api(ops, 'GET', '/api/v1/fleet/summary');
    return s.online === HUBS;
  }, `all ${HUBS} hubs online in the cloud`, 180_000, 2000);
  say(`all ${HUBS} hubs online in the cloud`);

  // --- resource sampling of the cloud process ------------------------------------------------------
  const resources = [];
  const sampleCloud = () => {
    if (process.platform === 'win32') {
      const out = spawnSync('wmic', ['process', 'where', `ProcessId=${cloud.pid}`, 'get', 'KernelModeTime,UserModeTime,WorkingSetSize', '/format:csv'], { encoding: 'utf8' }).stdout;
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop()?.split(',');
      if (line && line.length >= 4) resources.push({ at: Date.now(), cpuMs: (Number(line[1]) + Number(line[2])) / 10_000, rssMb: Math.round(Number(line[3]) / 2 ** 20) });
    } else {
      const stat = readFileSync(`/proc/${cloud.pid}/stat`, 'utf8').split(' ');
      resources.push({ at: Date.now(), cpuMs: ((Number(stat[13]) + Number(stat[14])) * 1000) / 100, rssMb: Math.round((Number(stat[23]) * 4096) / 2 ** 20) });
    }
  };
  const resourceTimer = setInterval(sampleCloud, 10_000);
  cleanups.push(() => clearInterval(resourceTimer));

  // --- users ----------------------------------------------------------------------------------------
  const now = Date.now();
  const measureStart = now + WARMUP * 60_000;
  const measureEnd = measureStart + MINUTES * 60_000;
  say(`users start (ramp 2 min); warm-up until ${new Date(measureStart).toISOString().slice(11, 19)}, measuring until ${new Date(measureEnd).toISOString().slice(11, 19)}`);
  const generator = fork(join(ROOT, 'tools/loadtest/users.mjs'), [planFile], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  cleanups.push(() => generator.kill());
  const results = await new Promise((resolve, reject) => {
    generator.on('message', (m) => {
      if (m.type === 'loaded') generator.send({ type: 'start', measureStart, measureEnd, rampMs: Math.min(120_000, WARMUP * 60_000) });
      if (m.type === 'results') resolve(m.results);
    });
    generator.once('exit', (code) => reject(new Error(`user generator exited (${code})`)));
    const progress = setInterval(() => {
      const left = measureEnd - Date.now();
      if (left > 0) say(`${Math.ceil(left / 60_000)} min left`);
    }, 5 * 60_000);
    cleanups.push(() => clearInterval(progress));
  });
  say('measured window over; collecting');

  // --- after the run: command outcomes, audit, database ---------------------------------------------
  await sleep(5000); // let in-flight commands settle
  const db = new pg.Client({ connectionString: pgUrl('voltax_owner') });
  await db.connect();
  const commandRows = (await db.query('SELECT command_id, grant_id, status, reason, requested_at, updated_at FROM grant_commands WHERE requested_at >= $1 AND requested_at < $2', [measureStart, measureEnd])).rows;
  const commandStates = {};
  const commandReasons = {};
  for (const c of commandRows) {
    commandStates[c.status] = (commandStates[c.status] ?? 0) + 1;
    if (c.status !== 'confirmed') commandReasons[`${c.status}: ${c.reason ?? '-'}`] = (commandReasons[`${c.status}: ${c.reason ?? '-'}`] ?? 0) + 1;
  }
  const ackMs = commandRows.filter((c) => c.status === 'confirmed').map((c) => Number(c.updated_at) - Number(c.requested_at));
  const slowestCommands = commandRows
    .map((c) => ({ commandId: c.command_id, grantId: c.grant_id, status: c.status, ms: Number(c.updated_at) - Number(c.requested_at) }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 5);
  const dbStats = {
    sizeMb: Math.round(Number((await db.query("SELECT pg_database_size('voltex') AS b")).rows[0].b) / 2 ** 20),
    auditRecords: Number((await db.query('SELECT count(*) AS n FROM audit_log')).rows[0].n),
    hubAuditRecords: Number((await db.query('SELECT count(*) AS n FROM hub_audit')).rows[0].n),
    grants: Number((await db.query('SELECT count(*) AS n FROM grants')).rows[0].n),
    notificationsByStatus: Object.fromEntries((await db.query('SELECT status, count(*)::int AS n FROM notifications GROUP BY status')).rows.map((x) => [x.status, x.n])),
  };
  await db.end();
  const verifyStart = performance.now();
  const auditVerify = await api(ops, 'POST', '/api/v1/audit/verify').catch((err) => ({ error: err.message }));
  const auditVerifyMs = Math.round(performance.now() - verifyStart);

  for (const w of workers) w.send({ type: 'stop' });
  await until(async () => workerStats.length === WORKERS, 'worker stats', 120_000, 500);
  clearInterval(resourceTimer);

  // --- verdict --------------------------------------------------------------------------------------
  const sum = (f) => workerStats.reduce((a, s) => a + f(s), 0);
  const adversarial = {
    forged: { sent: sum((s) => s.forged.sent), refused: sum((s) => s.forged.refused), accepted: sum((s) => s.forged.accepted), reasons: mergeCounts(workerStats.map((s) => s.forged.reasons)) },
    replayed: { sent: sum((s) => s.replayed.sent), refused: sum((s) => s.replayed.refused), accepted: sum((s) => s.replayed.accepted), reasons: mergeCounts(workerStats.map((s) => s.replayed.reasons)) },
    brokerIsolation: { probes: sum((s) => s.isolation.probes), controlFailures: sum((s) => s.isolation.controlFailures), subscribeGranted: sum((s) => s.isolation.subscribeGranted), violations: workerStats.flatMap((s) => s.isolation.violations) },
  };
  const hubsSide = {
    devices: sum((s) => s.devices),
    deviceStatePublishes: sum((s) => s.statePublishes),
    deviceCommandsExecuted: sum((s) => s.deviceCommands),
    ownerApprovals: sum((s) => s.approvals),
    ownerApprovalFailures: sum((s) => s.approvalFailures),
    ownerApprovalsAfterWithdrawal: sum((s) => s.approvalsTooLate),
    cloudLinkDownSamples: sum((s) => s.cloudLinkDownSamples),
    trace: {
      slowCommands: workerStats.flatMap((s) => s.trace.slowCommands),
      unansweredRequests: workerStats.flatMap((s) => s.trace.unansweredRequests),
      approvalFailures: workerStats.flatMap((s) => s.trace.approvalFailures),
    },
  };
  const o = results.overall;
  const errorRate = results.counts.measured ? results.counts.unexpected / results.counts.measured : 1;
  const gates = [
    { id: 'G1', what: 'API latency p95, all portal requests', threshold: '< 300 ms', value: `${o.p95} ms`, pass: o.p95 !== null && o.p95 < 300 },
    { id: 'G2', what: 'API latency p99, all portal requests', threshold: '< 1,000 ms', value: `${o.p99} ms`, pass: o.p99 !== null && o.p99 < 1000 },
    { id: 'G3', what: 'Unexpected errors', threshold: '< 0.1%', value: `${(errorRate * 100).toFixed(3)}% (${results.counts.unexpected} of ${results.counts.measured})`, pass: errorRate < 0.001 },
    {
      id: 'G4',
      what: 'Isolation violations (API + broker)',
      threshold: '0',
      value: `${results.violations.isolation.length} API, ${adversarial.brokerIsolation.violations.length} broker`,
      // A probe only counts when its positive control worked (the probe could have seen a leak).
      pass:
        results.violations.isolation.length === 0 &&
        adversarial.brokerIsolation.violations.length === 0 &&
        adversarial.brokerIsolation.subscribeGranted === 0 &&
        adversarial.brokerIsolation.probes > 0 &&
        adversarial.brokerIsolation.controlFailures === 0,
    },
    {
      id: 'G5',
      what: 'Invalid commands accepted (API probes, forged, replayed)',
      threshold: '0',
      value: `${results.violations.invalidGrant.length} API, ${adversarial.forged.accepted} forged, ${adversarial.replayed.accepted} replayed`,
      pass: results.violations.invalidGrant.length === 0 && adversarial.forged.accepted === 0 && adversarial.replayed.accepted === 0 && adversarial.forged.sent > 0 && adversarial.replayed.sent > 0,
    },
    {
      id: 'G6',
      what: 'Hubs online at every 1-minute sample',
      threshold: `${HUBS} of ${HUBS}`,
      value: results.fleetSamples.length ? `min ${Math.min(...results.fleetSamples.map((s) => s.online ?? 0))} over ${results.fleetSamples.length} samples` : 'no samples',
      pass: results.fleetSamples.length >= Math.floor(MINUTES) - 1 && results.fleetSamples.every((s) => s.online === HUBS),
    },
  ];
  const cpu = resources.length > 1 ? Math.round(((resources.at(-1).cpuMs - resources[0].cpuMs) / (resources.at(-1).at - resources[0].at)) * 100) : null;
  const out = {
    cloudRestarts,
    spec: 'docs/testing/load-test-spec.md (v1)',
    official: OFFICIAL,
    env: { ...env, endedAt: new Date().toISOString() },
    params: { minutes: MINUTES, warmupMinutes: WARMUP, hubs: HUBS, devicesPerHub: DEVICES_PER_HUB, users: USERS, telemetryMs: TELEMETRY_MS, measureStart: new Date(measureStart).toISOString(), measureEnd: new Date(measureEnd).toISOString() },
    pass: gates.every((g) => g.pass),
    gates,
    api: results,
    commands: { states: commandStates, reasons: commandReasons, ackMs: summarise(ackMs), slowest: slowestCommands },
    hubs: hubsSide,
    adversarial,
    cloudProcess: { avgCpuPercentOfOneCore: cpu, rssMb: summarise(resources.map((x) => x.rssMb)) },
    database: dbStats,
    auditVerify: { ...auditVerify, ms: auditVerifyMs },
  };
  const date = new Date().toISOString().slice(0, 10);
  const dir = OFFICIAL ? join(ROOT, 'docs/testing') : join(ROOT, 'tools/loadtest/.out');
  mkdirSync(dir, { recursive: true });
  const baseName = OFFICIAL ? `load-test-results-${date}` : `smoke-${date}-${Date.now()}`;
  writeFileSync(join(dir, `${baseName}.json`), `${JSON.stringify(out, null, 2)}\n`);
  writeFileSync(join(dir, `${baseName}.md`), markdown(out));
  say(`${out.pass ? 'PASS' : 'FAIL'}: ${gates.map((g) => `${g.id} ${g.pass ? 'ok' : 'FAIL'} (${g.value})`).join('; ')}`);
  say(`written ${join(dir, baseName)}.{json,md}`);
  process.exitCode = out.pass ? 0 : 1;
} finally {
  await cleanup();
}

function mergeCounts(list) {
  const out = {};
  for (const c of list) for (const [k, v] of Object.entries(c)) out[k] = (out[k] ?? 0) + v;
  return out;
}

function markdown(r) {
  const rows = (head, body) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...body.map((b) => `| ${b.join(' | ')} |`)].join('\n');
  const ep = Object.entries(r.api.endpoints).map(([k, s]) => [`\`${k}\``, s.count, s.p50, s.p95, s.p99, s.max]);
  return `# Load test results, ${r.env.startedAt.slice(0, 10)}${r.official ? '' : ' (smoke run, not the result)'}

Against [load-test-spec.md](${r.official ? '' : '../../../docs/testing/'}load-test-spec.md) v1. Generated by \`tools/loadtest/run.mjs\`; all numbers are in the
JSON file next to this one.

**Verdict: ${r.pass ? 'PASS' : 'FAIL'}**

${rows(['#', 'Criterion', 'Threshold', 'Measured', 'Result'], r.gates.map((g) => [g.id, g.what, g.threshold, g.value, g.pass ? 'pass' : '**FAIL**']))}

## Run

- Commit \`${r.env.commit}\`, ${r.env.startedAt} to ${r.env.endedAt}.
- ${r.params.hubs} hubs × ${r.params.devicesPerHub} devices, ${r.params.users} users, telemetry every ${r.params.telemetryMs / 1000} s; warm-up ${r.params.warmupMinutes} min, measured ${r.params.minutes} min (${r.params.measureStart} to ${r.params.measureEnd}).
- Machine: ${r.env.os}, ${r.env.cpu}, ${r.env.ramGb} GB RAM. Node ${r.env.node}, PostgreSQL ${r.env.postgres}, ${r.env.emqx}, ${r.env.mailpit}, Docker ${r.env.docker}; ${r.env.workers} hub worker processes.

## API latency (measured window)

Overall: ${r.api.overall.count} requests, p50 ${r.api.overall.p50} ms, p95 ${r.api.overall.p95} ms, p99 ${r.api.overall.p99} ms, max ${r.api.overall.max} ms.
Expected denials (isolation and invalid-grant probes answered 403/404/409): ${r.api.counts.expectedDenials}.

${rows(['Endpoint', 'Count', 'p50 ms', 'p95 ms', 'p99 ms', 'max ms'], ep)}

Unexpected errors by kind: ${Object.keys(r.api.unexpectedByKind).length ? '' : 'none.'}
${Object.entries(r.api.unexpectedByKind).map(([k, n]) => `- \`${k}\`: ${n}`).join('\n')}

## Support sessions and commands

- Sessions: ${r.api.sessions.requested} requested, ${r.api.sessions.active} approved by the owner and active, ${r.api.sessions.neverActive} never active, ${r.api.sessions.finished} finished. Time from request to active (owner approves after 2–5 s, portal polls every 5 s): p50 ${r.api.sessions.timeToActiveMs.p50} ms, p95 ${r.api.sessions.timeToActiveMs.p95} ms.
- Commands requested in the window, by final state: ${JSON.stringify(r.commands.states)}; not confirmed, by reason: ${JSON.stringify(r.commands.reasons)}.
- Command acknowledgement (cloud \`updatedAt − requestedAt\`, confirmed only): p50 ${r.commands.ackMs.p50} ms, p95 ${r.commands.ackMs.p95} ms, p99 ${r.commands.ackMs.p99} ms, max ${r.commands.ackMs.max} ms (${r.commands.ackMs.count} commands).
- Devices: ${r.hubs.devices}; state publishes ${r.hubs.deviceStatePublishes}; commands executed by devices ${r.hubs.deviceCommandsExecuted}; owner approvals ${r.hubs.ownerApprovals} (failures ${r.hubs.ownerApprovalFailures}; refused because the requester had already withdrawn ${r.hubs.ownerApprovalsAfterWithdrawal}); hub cloud-link down samples ${r.hubs.cloudLinkDownSamples}.
- Hub-side traces (details in the JSON): ${r.hubs.trace.slowCommands.length} commands finished > 5 s after issue, ${r.hubs.trace.unansweredRequests.length} diagnostics/activity requests unanswered after 10 s, ${r.hubs.trace.approvalFailures.length} owner approval failures. Slowest commands (cloud view): ${JSON.stringify(r.commands.slowest.map((c) => `${c.status} ${c.ms} ms`))}.

## Security under load (whole run, warm-up included)

- API isolation violations: ${r.api.violations.isolation.length}. Invalid-grant probes accepted: ${r.api.violations.invalidGrant.length}.
- Forged envelopes (wrong key): ${r.adversarial.forged.sent} sent, ${r.adversarial.forged.refused} refused (${JSON.stringify(r.adversarial.forged.reasons)}), ${r.adversarial.forged.accepted} accepted.
- Replayed envelopes: ${r.adversarial.replayed.sent} sent, ${r.adversarial.replayed.refused} refused (${JSON.stringify(r.adversarial.replayed.reasons)}), ${r.adversarial.replayed.accepted} accepted.
- Broker isolation probes: ${r.adversarial.brokerIsolation.probes} (positive-control failures: ${r.adversarial.brokerIsolation.controlFailures}); cross-hub subscriptions granted by EMQX: ${r.adversarial.brokerIsolation.subscribeGranted}; marker messages that crossed: ${r.adversarial.brokerIsolation.violations.length}.

## Telemetry and resources

- Fleet samples (hubs online): ${r.api.fleetSamples.map((s) => s.online).join(', ') || 'none'}.
- Cloud process restarts (startup included): ${r.cloudRestarts.length ? r.cloudRestarts.map((x) => `${x.at} (exit ${x.code})`).join(', ') : 'none'}.
- Cloud process: average CPU ${r.cloudProcess.avgCpuPercentOfOneCore}% of one core; memory p50 ${r.cloudProcess.rssMb.p50} MB, max ${r.cloudProcess.rssMb.max} MB.
- Database at the end: ${r.database.sizeMb} MB; ${r.database.auditRecords} cloud audit records, ${r.database.hubAuditRecords} hub audit records copied off the hubs, ${r.database.grants} grants; notices ${JSON.stringify(r.database.notificationsByStatus)}.
- Audit verify at the end: ${r.auditVerify.ok === true ? 'chain intact' : `NOT OK ${JSON.stringify(r.auditVerify)}`} (${r.auditVerify.chain?.count ?? '?'} records, ${r.auditVerify.checkpoints ?? '?'} checkpoints, ${r.auditVerify.ms} ms).
`;
}
