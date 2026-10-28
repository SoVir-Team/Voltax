import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import aedes, { type Client } from 'aedes';
import { brokerAllows, CLOUD_SERVICE_USER } from '../src/broker.js';

/** Which real broker the end-to-end test runs on (npm run test:brokers sets this). */
export type BrokerKind = 'aedes' | 'mosquitto' | 'emqx';
export const BROKER_KIND = (process.env.VOLTAX_TEST_CLOUD_BROKER ?? 'aedes') as BrokerKind;

export interface TestBroker {
  url: string;
  close: () => Promise<void>;
  /** Refusals seen by the broker (in-process broker only; real brokers just refuse). */
  denied: string[] | null;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

async function waitForPort(port: number, timeoutMs: number, what: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    const open = await new Promise<boolean>((resolve) => {
      const sock = connect(port, '127.0.0.1');
      sock.once('connect', () => (sock.destroy(), resolve(true)));
      sock.once('error', () => resolve(false));
    });
    if (open) return;
    if (Date.now() - start > timeoutMs) throw new Error(`${what} did not open port ${port}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * In-process cloud broker that enforces the same authentication and ACL as production (EMQX calls
 * the cloud's /broker/authn and /broker/authz, which use the same functions).
 */
export async function startCloudBroker(authenticate: (username: string, password: string) => Promise<boolean>, port = 0): Promise<TestBroker> {
  const users = new WeakMap<Client, string>();
  const denied: string[] = [];
  const broker = aedes.createBroker({
    authenticate: (client, username, password, done) => {
      const user = username ?? '';
      authenticate(user, password?.toString() ?? '')
        .then((ok) => {
          if (ok) users.set(client, user);
          else denied.push(`connect:${user}`);
          done(null, ok);
        })
        .catch(() => done(null, false));
    },
    authorizePublish: (client, packet, done) => {
      const user = client ? users.get(client) : undefined;
      if (user && brokerAllows(user, 'publish', packet.topic)) return done(null);
      denied.push(`publish:${user}:${packet.topic}`);
      done(new Error('not authorised'));
    },
    authorizeSubscribe: (client, sub, done) => {
      const user = users.get(client);
      if (user && brokerAllows(user, 'subscribe', sub.topic)) return done(null, sub);
      denied.push(`subscribe:${user}:${sub.topic}`);
      done(null, null);
    },
  });
  const server: Server = createServer(broker.handle);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `mqtt://127.0.0.1:${(server.address() as AddressInfo).port}`,
    denied,
    close: () => new Promise<void>((resolve) => broker.close(() => server.close(() => resolve()))),
  };
}

// ---------------------------------------------------------------------------------------------
// Native Mosquitto: a SEPARATE process on its own port with its own config. The Mosquitto Windows
// service (if installed) is never touched.

const MOSQUITTO_DIR = process.env.MOSQUITTO_DIR ?? (process.platform === 'win32' ? 'C:\\Program Files\\mosquitto' : '');
const mosqExe = (name: string) => (MOSQUITTO_DIR ? join(MOSQUITTO_DIR, process.platform === 'win32' ? `${name}.exe` : name) : name);

/** The cloud broker ACL (brokerAllows) written as a Mosquitto ACL file, for a Mosquitto cloud broker. */
export const CLOUD_MOSQUITTO_ACL = [
  `user ${CLOUD_SERVICE_USER}`,
  'topic read voltax-cloud/+/up',
  'topic read voltax-cloud/+/status',
  'topic write voltax-cloud/+/down',
  '',
  '# every hub: username = hub id',
  'pattern read voltax-cloud/%u/down',
  'pattern write voltax-cloud/%u/up',
  'pattern write voltax-cloud/%u/status',
  '',
].join('\n');

/** The hub's local broker ACL exactly as deploy/pi/provision.sh renders it. */
export function piMosquittoAcl(hubId: string): string {
  const template = readFileSync(new URL('../../../deploy/pi/mosquitto/acl.template', import.meta.url), 'utf8');
  return template.replaceAll('__HUB_ID__', hubId);
}

export async function startMosquitto(users: Array<{ username: string; password: string }>, acl: string, port?: number): Promise<TestBroker & { log: () => string }> {
  const dir = mkdtempSync(join(tmpdir(), 'voltax-mosq-'));
  const slash = (p: string) => p.replace(/\\/g, '/');
  const passwd = join(dir, 'passwd');
  const logFile = join(dir, 'mosquitto.log');
  writeFileSync(passwd, users.map((u) => `${u.username}:${u.password}`).join('\n') + '\n');
  const hashed = spawnSync(mosqExe('mosquitto_passwd'), ['-U', passwd], { encoding: 'utf8' });
  if (hashed.status !== 0) throw new Error(`mosquitto_passwd failed: ${hashed.stderr}`);
  writeFileSync(join(dir, 'acl'), acl);
  port ??= await freePort();
  const conf = join(dir, 'mosquitto.conf');
  writeFileSync(
    conf,
    [
      'per_listener_settings false',
      `listener ${port} 127.0.0.1`,
      'allow_anonymous false',
      `password_file ${slash(passwd)}`,
      `acl_file ${slash(join(dir, 'acl'))}`,
      'persistence false',
      `log_dest file ${slash(logFile)}`,
      'log_type error',
      'log_type warning',
      'log_type notice',
      'log_type subscribe',
      'connection_messages true',
      '',
    ].join('\n'),
  );
  const proc = spawn(mosqExe('mosquitto'), ['-c', conf], { stdio: 'ignore' });
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  await waitForPort(port, 10_000, 'mosquitto');
  return {
    url: `mqtt://127.0.0.1:${port}`,
    denied: null,
    log: () => readFileSync(logFile, 'utf8'),
    close: async () => {
      proc.kill();
      await exited;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// EMQX in Docker, authenticating and authorising every client through the cloud's internal API
// (the production arrangement: /broker/authn and /broker/authz behind a shared secret).

export const EMQX_IMAGE = process.env.VOLTAX_TEST_EMQX_IMAGE ?? 'emqx/emqx:5.8.6';

export function emqxConfig(internalUrl: string, sharedSecret: string): string {
  const headers = `headers { "content-type" = "application/json", "x-voltax-broker-secret" = "${sharedSecret}" }`;
  return [
    `node { name = "emqx@127.0.0.1", cookie = "${randomBytes(16).toString('hex')}", data_dir = "data" }`,
    'cluster { name = voltaxtest, discovery_strategy = manual }',
    'dashboard { listeners.http.bind = 0 }',
    'listeners.tcp.default { bind = "0.0.0.0:1883" }',
    'listeners.ssl.default { enable = false }',
    'listeners.ws.default { enable = false }',
    'listeners.wss.default { enable = false }',
    'authentication = [{',
    '  mechanism = password_based, backend = http, enable = true, method = post',
    `  url = "${internalUrl}/broker/authn"`,
    `  ${headers}`,
    '  body { username = "${username}", password = "${password}" }',
    '  request_timeout = "5s"',
    '}]',
    'authorization {',
    '  no_match = deny',
    '  deny_action = ignore',
    '  cache { enable = false }',
    '  sources = [{',
    '    type = http, enable = true, method = post',
    `    url = "${internalUrl}/broker/authz"`,
    `    ${headers}`,
    '    body { username = "${username}", topic = "${topic}", action = "${action}" }',
    '    request_timeout = "5s"',
    '  }]',
    '}',
    '',
  ].join('\n');
}

const docker = (args: string[]) => spawnSync('docker', args, { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });

/** Starts EMQX; `internalPort` is the cloud internal API on this machine (reached via host.docker.internal). */
export async function startEmqx(internalPort: number, sharedSecret: string, port?: number): Promise<TestBroker & { logs: () => string }> {
  const dir = mkdtempSync(join(tmpdir(), 'voltax-emqx-'));
  const conf = join(dir, 'emqx.conf');
  writeFileSync(conf, emqxConfig(`http://host.docker.internal:${internalPort}`, sharedSecret));
  port ??= await freePort();
  const name = `voltax-test-emqx-${randomBytes(4).toString('hex')}`;
  const run = docker(['run', '-d', '--rm', '--name', name, '--add-host', 'host.docker.internal:host-gateway', '-p', `127.0.0.1:${port}:1883`, '-v', `${conf}:/opt/emqx/etc/emqx.conf:ro`, EMQX_IMAGE]);
  if (run.status !== 0) throw new Error(`docker run emqx failed: ${run.stderr}`);
  const logs = () => docker(['logs', name]).stdout + docker(['logs', name]).stderr;
  const stop = async () => {
    docker(['rm', '-f', name]);
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const start = Date.now();
    while (!docker(['exec', name, 'emqx', 'ctl', 'status']).stdout.includes('is started')) {
      if (Date.now() - start > 120_000) throw new Error(`EMQX did not start:\n${logs()}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    await waitForPort(port, 20_000, 'emqx');
  } catch (err) {
    await stop();
    throw err;
  }
  return { url: `mqtt://127.0.0.1:${port}`, denied: null, logs, close: stop };
}
