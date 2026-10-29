import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import { cloudEnvelopeSchema, GRANT_ACTIONS, platformScope, type CloudEnvelope, type GrantAction, type PlatformRole, type SignedEnvelope } from '@voltax/contracts';
import { SESSION_COOKIE, type CloudApiConfig } from '../src/api.js';
import { createCloud, type Cloud, type CloudOptions } from '../src/cloud.js';
import pg from 'pg';
import { pgDb, pgliteDb, type Db } from '../src/db.js';

/**
 * Database for one test cloud: PGlite in-process by default; with VOLTAX_TEST_PG_ADMIN set (npm run
 * test:pg) a brand-new database on a real PostgreSQL server, owned by voltax_owner.
 */
export async function testDb(): Promise<Db> {
  const admin = process.env.VOLTAX_TEST_PG_ADMIN;
  if (!admin) return pgliteDb();
  const name = `voltax_t_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const client = new pg.Client({ connectionString: admin });
  await client.connect();
  await client.query(`CREATE DATABASE ${name} OWNER voltax_owner`);
  await client.end();
  return pgDb(pgUrl(admin, name, 'voltax_owner'));
}

export function pgUrl(admin: string, database: string, user: string): string {
  const u = new URL(admin);
  u.username = user;
  u.pathname = `/${database}`;
  return u.toString();
}

export const PASSWORD = 'correct horse battery staple';

// --- releases: a throwaway minisign-format release key (interop with the real tool is proven by
// test/minisign.test.ts against signatures made by minisign 0.11) ------------------------------------
export const releaseKey = generateKeyPairSync('ed25519');
const RELEASE_KEY_ID = randomBytes(8);
const rawPublic = (k: KeyObject) => Buffer.from(k.export({ format: 'jwk' }).x!, 'base64url');
export const releasePublicKeyText = `untrusted comment: minisign public key (tests)\n${Buffer.concat([Buffer.from('Ed'), RELEASE_KEY_ID, rawPublic(releaseKey.publicKey)]).toString('base64')}\n`;

/** Signs like `minisign -S` (prehashed). */
export function minisignSign(message: string, trustedComment: string, key: KeyObject = releaseKey.privateKey, keyId: Buffer = RELEASE_KEY_ID): string {
  const sig = sign(null, createHash('blake2b512').update(message).digest(), key);
  const global = sign(null, Buffer.concat([sig, Buffer.from(trustedComment)]), key);
  return ['untrusted comment: signature from minisign secret key', Buffer.concat([Buffer.from('ED'), keyId, sig]).toString('base64'), `trusted comment: ${trustedComment}`, global.toString('base64'), ''].join('\n');
}

const hex64 = (c: string) => c.repeat(64);
/** A hub release as the release workflow produces it: release.json + its minisig. */
export function hubRelease(version: string, opts: { minFromVersion?: string; key?: KeyObject } = {}) {
  const manifest = JSON.stringify({
    version,
    hubImage: `ghcr.io/voltex/hub@sha256:${hex64('a')}`,
    mosquittoImage: `eclipse-mosquitto@sha256:${hex64('b')}`,
    composeSha256: hex64('c'),
    commit: '0'.repeat(40),
    builtAt: '2026-10-28T10:00:00Z',
  });
  return { kind: 'hub' as const, manifest, signature: minisignSign(manifest, `voltax hub ${version}`, opts.key), ...(opts.minFromVersion ? { minFromVersion: opts.minFromVersion } : {}) };
}

export function firmwareRelease(version: string, board = 'esp32') {
  const manifest = JSON.stringify({ version, board, sha256: hex64('d'), size: 1_200_000, minHubVersion: '1.0.0' });
  return { kind: 'esp32' as const, manifest, signature: minisignSign(manifest, `voltax firmware ${board} ${version}`) };
}

export interface TestStaff {
  staffId: string;
  email: string;
  role: PlatformRole;
  cookie: string;
}

export interface FakeHub {
  /** Every envelope the cloud published, decoded (signature checked separately in tests). */
  published: Array<{ hubId: string; signed: SignedEnvelope; envelope: CloudEnvelope }>;
  /** When false the hub is "offline": envelopes are captured but nothing answers. */
  answering: boolean;
}

export interface TestCloud extends Cloud {
  /** Fully signed-in staff member (email + password). */
  addStaff(role: PlatformRole, name?: string): Promise<TestStaff>;
  login(s: Pick<TestStaff, 'email'>): Promise<string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read arbitrary response JSON
  req(method: string, url: string, opts?: { cookie?: string; body?: unknown; headers?: Record<string, string> }): Promise<{ status: number; body: any; headers: Record<string, unknown> }>;
  addHome(name?: string): Promise<string>;
  assign(staffId: string, homeId: string, expiresAt?: number | null): Promise<string>;
  /** Registers a hub for the home and records telemetry listing these devices. */
  addHub(homeId: string, hubId: string, devices?: string[]): Promise<void>;
  /** Telemetry from the hub saying it runs this version (and is online now). */
  setHubVersion(hubId: string, version: string): Promise<void>;
  /** Inserts an owner-approved, noticed, active grant (as if the hub had reported it). */
  activeGrant(homeId: string, staff: Pick<TestStaff, 'staffId' | 'role'>, actions?: GrantAction[], devices?: string[]): Promise<string>;
  hub: FakeHub;
  commandPublicKeyPem: string;
}

export interface StartOptions {
  db?: Db;
  api?: Partial<CloudApiConfig>;
  /** Replace the fake hub with another transport (or null = remote support not configured). */
  transport?: CloudOptions['transport'] | null;
  extra?: Partial<CloudOptions>;
}

const ed25519Pem = () => generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

export async function startCloud(opts: StartOptions = {}): Promise<TestCloud> {
  const hub: FakeHub = { published: [], answering: true };
  const commandKeyPem = ed25519Pem();
  let cloudRef: Cloud | null = null;

  // A cooperative hub: answers the way backend/hub does when everything is allowed.
  const fakeTransport: NonNullable<CloudOptions['transport']> = {
    async publish(hubId, signed) {
      const envelope = cloudEnvelopeSchema.parse(JSON.parse(signed.payload));
      hub.published.push({ hubId, signed, envelope });
      if (!hub.answering) return;
      const reply = (msg: Parameters<Cloud['route']>[1]): void => {
        setImmediate(() => void cloudRef!.route(hubId, msg).catch(() => undefined)); // may land after close
      };
      switch (envelope.type) {
        case 'command':
          return reply({ type: 'command.result', commandId: envelope.commandId, grantId: envelope.grantId, status: 'confirmed' });
        case 'diagnostics.request':
          return reply({
            type: 'diagnostics.result',
            requestId: envelope.requestId,
            grantId: envelope.grantId,
            diagnostics: { version: '1.0.0', uptime: 5, db: 'up', mqtt: 'up', timeSynced: true, devices: [], commandsLast24h: { confirmed: 0, failed: 0, expired: 0 }, eventLogSeq: 1 },
          });
        case 'activity.request':
          return reply({ type: 'activity.result', requestId: envelope.requestId, grantId: envelope.grantId, events: [] });
        case 'grant.revoke':
          return reply({ type: 'grant.status', grantId: envelope.grantId, status: envelope.outcome === 'completed' ? 'completed' : 'revoked', at: Date.now(), reason: envelope.reason });
        case 'customer.onboard': {
          // Like backend/hub: a 10-character code, then a fresh challenge (each one works once).
          const code = randomBytes(10).toString('hex').toUpperCase().slice(0, 10);
          reply({ type: 'customer.onboard.result', requestId: envelope.envelopeId, result: { ok: true, code, expiresAt: Date.now() + 600_000, email: envelope.email } });
          return reply({ type: 'customer.ready', challenge: randomBytes(32).toString('base64url'), claimed: false });
        }
        default:
          return;
      }
    },
  };

  const cloud = await createCloud({
    db: opts.db ?? (await testDb()),
    dataKey: randomBytes(32),
    commandKeyPem,
    auditKeyPem: ed25519Pem(),
    releasePublicKey: releasePublicKeyText,
    scryptCost: { N: 1024, r: 8, p: 1 }, // tests only; production uses SCRYPT_DEFAULT
    api: { cookieSecure: false, loginLimitPerMinute: 10_000, ...opts.api },
    ...(opts.transport === null ? {} : { transport: opts.transport ?? fakeTransport }),
    ...opts.extra,
  });
  cloudRef = cloud;
  const systemAdmin = randomUUID();

  const req: TestCloud['req'] = async (method, url, o = {}) => {
    const res = await cloud.app.inject({
      method: method as 'GET',
      url,
      headers: { ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.headers ?? {}) },
      ...(o.body !== undefined ? { payload: o.body as object } : {}),
    });
    let body: unknown = res.body;
    try {
      body = res.json();
    } catch {
      /* not JSON */
    }
    return { status: res.statusCode, body, headers: res.headers };
  };

  const cookieFrom = (headers: Record<string, unknown>): string => {
    const raw = String(headers['set-cookie'] ?? '');
    const token = raw.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1];
    if (!token) throw new Error(`no session cookie in ${raw}`);
    return `${SESSION_COOKIE}=${token}`;
  };

  const login: TestCloud['login'] = async (s) => {
    const res = await req('POST', '/api/v1/auth/login', { body: { email: s.email, password: PASSWORD } });
    if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
    return cookieFrom(res.headers);
  };

  return Object.assign(cloud, {
    req,
    login,
    hub,
    commandPublicKeyPem: cloud.signer!.publicKeyPem,
    async addStaff(role: PlatformRole, name = role.toLowerCase()) {
      const email = `${name}-${randomUUID().slice(0, 8)}@voltex.test`;
      const { staff, setupToken } = await cloud.staff.create({ email, displayName: name, role }, 'cli');
      const setup = await req('POST', '/api/v1/auth/setup', { body: { token: setupToken, password: PASSWORD } });
      const setupCookie = cookieFrom(setup.headers);
      return { staffId: staff.staffId, email, role, cookie: setupCookie };
    },
    async addHome(name = 'Test home') {
      return (await cloud.homes.create({ name, ownerContact: 'owner@example.test' }, systemAdmin)).homeId;
    },
    async assign(staffId: string, homeId: string, expiresAt: number | null = null) {
      return (await cloud.homes.assign({ staffId, homeId, expiresAt }, systemAdmin)).assignmentId;
    },
    async setHubVersion(hubId: string, version: string) {
      await cloud.homes.recordTelemetry(hubId, { version, uptime: 1, db: 'up', mqtt: 'up', timeSynced: true, devices: [], update: { state: 'idle' }, at: Date.now() });
    },
    async addHub(homeId: string, hubId: string, devices = ['kitchen', 'porch']) {
      await cloud.homes.registerHub(homeId, hubId, systemAdmin);
      await cloud.homes.recordTelemetry(hubId, {
        version: '1.0.0',
        uptime: 1,
        db: 'up',
        mqtt: 'up',
        timeSynced: true,
        devices: devices.map((deviceId) => ({ deviceId, online: true })),
        update: { state: 'idle' },
        at: Date.now(),
      });
      // The hub announces a fresh onboarding challenge with its telemetry (see backend/hub cloud-link).
      await cloud.route(hubId, { type: 'customer.ready', challenge: randomBytes(32).toString('base64url'), claimed: false });
    },
    async activeGrant(homeId: string, staff: Pick<TestStaff, 'staffId' | 'role'>, actions?: GrantAction[], devices = ['kitchen']) {
      const allowed = actions ?? GRANT_ACTIONS.filter((a) => platformScope(staff.role, a) === 'grant');
      const hubId = (await cloud.homes.hubOf(homeId))!;
      const now = Date.now();
      const grantId = randomUUID();
      await cloud.db.query("UPDATE grants SET status = 'revoked', ended_at = $3 WHERE home_id = $1 AND staff_id = $2 AND status IN ('pending', 'active')", [homeId, staff.staffId, now]);
      await cloud.db.query(
        `INSERT INTO grants (grant_id, home_id, hub_id, staff_id, staff_role, device_ids, actions, reason, starts_at, ends_at, status, requested_at, request_envelope_id, start_notice_at, hub_updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'test support session', $8, $9, 'active', $8, $10, $8, $8)`,
        [grantId, homeId, hubId, staff.staffId, staff.role, JSON.stringify(devices), JSON.stringify(allowed), now - 1000, now + 3_600_000, randomUUID()],
      );
      await cloud.db.query("INSERT INTO notifications (id, grant_id, home_id, kind, channel, status, created_at, delivered_at) VALUES ($1, $2, $3, 'support.started', 'in_app', 'delivered', $4, $4)", [
        randomUUID(),
        grantId,
        homeId,
        now,
      ]);
      return grantId;
    },
  });
}
