import { randomBytes, randomUUID } from 'node:crypto';
import type { PlatformRole } from '@voltax/contracts';
import { SESSION_COOKIE } from '../src/api.js';
import { createCloud, type Cloud } from '../src/cloud.js';
import { TOTP_STEP_MS, totpAt } from '../src/crypto.js';
import type { CloudApiConfig } from '../src/api.js';
import { pgliteDb, type Db } from '../src/db.js';

export const PASSWORD = 'correct horse battery staple';

export interface TestStaff {
  staffId: string;
  email: string;
  role: PlatformRole;
  secret: string;
  cookie: string;
}

export interface TestCloud extends Cloud {
  /** Fully signed-in staff member (password + TOTP). */
  addStaff(role: PlatformRole, name?: string): Promise<TestStaff>;
  /** Returns a TOTP code for a step after the last accepted one (codes are single-use). */
  nextCode(staffId: string, secret: string): Promise<string>;
  login(s: Pick<TestStaff, 'email' | 'staffId' | 'secret'>): Promise<string>;
  req(method: string, url: string, opts?: { cookie?: string; body?: unknown; headers?: Record<string, string> }): Promise<{ status: number; body: any; headers: Record<string, unknown> }>;
  addHome(name?: string): Promise<string>;
  assign(staffId: string, homeId: string, expiresAt?: number | null): Promise<string>;
}

export async function startCloud(opts: { db?: Db; api?: Partial<CloudApiConfig> } = {}): Promise<TestCloud> {
  const cloud = await createCloud({
    db: opts.db ?? (await pgliteDb()),
    dataKey: randomBytes(32),
    scryptCost: { N: 1024, r: 8, p: 1 }, // tests only; production uses SCRYPT_DEFAULT
    api: { cookieSecure: false, loginLimitPerMinute: 10_000, ...opts.api },
  });
  const systemAdmin = randomUUID();

  const req: TestCloud['req'] = async (method, url, opts = {}) => {
    const res = await cloud.app.inject({
      method: method as 'GET',
      url,
      headers: { ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.headers ?? {}) },
      ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
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

  const nextCode: TestCloud['nextCode'] = async (staffId, secret) => {
    const [row] = await cloud.db.query<{ totp_last_step: number | null }>('SELECT totp_last_step FROM staff WHERE id = $1', [staffId]);
    const now = Math.floor(Date.now() / TOTP_STEP_MS);
    const step = Math.max(now - 1, (row?.totp_last_step ?? -10) + 1);
    if (step > now + 1) throw new Error('out of TOTP steps for this 30 s window');
    return totpAt(secret, step);
  };

  const login: TestCloud['login'] = async (s) => {
    const res = await req('POST', '/api/v1/auth/login', { body: { email: s.email, password: PASSWORD, code: await nextCode(s.staffId, s.secret) } });
    if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
    return cookieFrom(res.headers);
  };

  return Object.assign(cloud, {
    req,
    nextCode,
    login,
    async addStaff(role: PlatformRole, name = role.toLowerCase()) {
      const email = `${name}-${randomUUID().slice(0, 8)}@voltex.test`;
      const { staff, setupToken } = await cloud.staff.create({ email, displayName: name, role }, 'cli');
      const setup = await req('POST', '/api/v1/auth/setup', { body: { token: setupToken, password: PASSWORD } });
      const setupCookie = cookieFrom(setup.headers);
      const begin = await req('POST', '/api/v1/auth/totp/begin', { cookie: setupCookie });
      const secret = begin.body.secret as string;
      const confirm = await req('POST', '/api/v1/auth/totp/confirm', { cookie: setupCookie, body: { code: totpAt(secret, Math.floor(Date.now() / TOTP_STEP_MS)) } });
      if (confirm.status !== 200) throw new Error(`totp confirm failed: ${JSON.stringify(confirm.body)}`);
      return { staffId: staff.staffId, email, role, secret, cookie: setupCookie };
    },
    async addHome(name = 'Test home') {
      return (await cloud.homes.create({ name, ownerContact: 'owner@example.test' }, systemAdmin)).homeId;
    },
    async assign(staffId: string, homeId: string, expiresAt: number | null = null) {
      return (await cloud.homes.assign({ staffId, homeId, expiresAt }, systemAdmin)).assignmentId;
    },
  });
}
