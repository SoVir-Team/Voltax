import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CloudEnvelope } from '@voltax/contracts';
import { RELAY, startEnv, type TestEnv } from './helpers.js';

// Household accounts (docs/customer-account-flow.md):
// admin code -> owner signs up -> signs in -> controls; owner invites family by email -> they sign up
// -> sign in -> only granted devices; both recover passwords with an emailed one-time code.

const ORIGIN = 'https://home.example.test';
const mailbox: Array<{ to: string; subject: string; text: string }> = [];
let failMail = false;
let env: TestEnv;

beforeAll(async () => {
  env = await startEnv({
    customer: {
      origin: ORIGIN,
      cookieSecure: false,
      scryptN: 1024, // tests only; production uses 2^17
      mail: {
        async send(m) {
          if (failMail) throw new Error('smtp down');
          mailbox.push(m);
        },
      },
    },
  });
});
afterAll(() => env.close());

type Res = { status: number; body: any; cookies: string[] }; // eslint-disable-line @typescript-eslint/no-explicit-any -- arbitrary JSON
let ipSeq = 0;
/** Each request from its own address unless given one: the per-address limits are tested on their own. */
async function req(method: string, url: string, o: { cookie?: string; body?: unknown; origin?: string; ip?: string } = {}): Promise<Res> {
  const res = await env.hub.app.inject({
    method: method as 'GET',
    url,
    remoteAddress: o.ip ?? `10.0.${(++ipSeq >> 8) & 255}.${ipSeq & 255}`,
    headers: { ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.origin ? { origin: o.origin } : {}) },
    ...(o.body !== undefined ? { payload: o.body as object } : {}),
  });
  const raw = res.headers['set-cookie'];
  const cookies = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((c) => c.split(';')[0]!).filter((c) => !c.endsWith('='));
  let body: unknown = res.body;
  try {
    body = res.json();
  } catch {
    /* empty */
  }
  return { status: res.statusCode, body, cookies };
}

/** What the cloud relays when the admin presses "Generate code" (the envelope itself is verified in envelope tests). */
function adminCode(email: string): string {
  const { challenge } = env.hub.customers.ready();
  const onboard = { v: 1, type: 'customer.onboard', envelopeId: randomUUID(), hubId: 'test-hub', actor: { staffId: randomUUID(), role: 'PLATFORM_SUPER_ADMIN', displayName: 'Admin' }, email, challenge, issuedAt: Date.now(), expiresAt: Date.now() + 60_000 } as Extract<CloudEnvelope, { type: 'customer.onboard' }>;
  const out = env.hub.customers.onboard(onboard);
  if (!out.result.ok) throw new Error(out.result.message);
  return out.result.code;
}

async function signUpAndIn(secret: string, email: string, password: string, name = 'Someone'): Promise<string> {
  const claim = await req('POST', '/api/v1/customer/claim', { body: { code: secret } });
  expect(claim.status, JSON.stringify(claim.body)).toBe(200);
  const signup = await req('POST', '/api/v1/customer/signup', { cookie: claim.cookies[0], body: { email, name, password } });
  expect(signup.status, JSON.stringify(signup.body)).toBe(201);
  expect(signup.cookies.some((c) => c.startsWith('voltax_customer='))).toBe(false); // signing up does not sign in
  const login = await req('POST', '/api/v1/customer/login', { body: { email, password } });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  return login.cookies.find((c) => c.startsWith('voltax_customer='))!;
}

const OWNER = 'owner@example.test';
const OWNER_PW = 'owner password 123';
let ownerCookie = '';

describe('homeowner', () => {
  it('the code only opens account setup: no controls until the owner has signed up and signed in', async () => {
    const code = adminCode(OWNER);
    const claim = await req('POST', '/api/v1/customer/claim', { body: { code: `${code.slice(0, 5)}-${code.slice(5).toLowerCase()}` } });
    expect(claim.status).toBe(200);
    expect(claim.body).toEqual({ email: OWNER, role: 'owner' });
    const setupCookie = claim.cookies[0]!;
    expect(setupCookie.startsWith('voltax_customer_setup=')).toBe(true);
    for (const [method, url] of [['GET', '/api/v1/devices'], ['GET', '/api/v1/me'], ['POST', `/api/v1/entities/${RELAY}/commands`]] as const) {
      expect((await req(method, url, { cookie: setupCookie, body: method === 'POST' ? { commandId: randomUUID(), value: true } : undefined })).status, url).toBe(401);
    }
    expect((await req('GET', '/api/v1/customer/setup', { cookie: setupCookie })).body).toEqual({ email: OWNER, role: 'owner' });
    const wrongEmail = await req('POST', '/api/v1/customer/signup', { cookie: setupCookie, body: { email: 'someone@else.test', name: 'X', password: OWNER_PW } });
    expect(wrongEmail.status).toBe(400);
    expect((await req('POST', '/api/v1/customer/signup', { cookie: setupCookie, body: { email: OWNER, name: 'Owner', password: 'short' } })).status).toBe(400);
    expect((await req('POST', '/api/v1/customer/signup', { cookie: setupCookie, body: { email: OWNER, name: 'Owner', password: OWNER_PW } })).status).toBe(201);

    // A used code is gone, and the home now has an owner.
    expect((await req('POST', '/api/v1/customer/claim', { body: { code } })).status).toBe(400);
    expect(env.hub.customers.ready().claimed).toBe(true);
    expect(() => adminCode('intruder@example.test')).toThrow(/already has a customer owner/);

    const login = await req('POST', '/api/v1/customer/login', { body: { email: 'OWNER@example.test', password: OWNER_PW } });
    expect(login.status).toBe(200);
    expect(login.body.role).toBe('owner');
    ownerCookie = login.cookies.find((c) => c.startsWith('voltax_customer='))!;
    expect((await req('GET', '/api/v1/devices', { cookie: ownerCookie })).body.map((d: { deviceId: string }) => d.deviceId)).toEqual(['esp-relay-01']);
    expect((await req('POST', `/api/v1/entities/${RELAY}/commands`, { cookie: ownerCookie, body: { commandId: randomUUID(), value: true } })).status).toBe(202);
  });

  it('a wrong password is refused, and five in a row lock the account for a while', async () => {
    for (let i = 0; i < 5; i++) expect((await req('POST', '/api/v1/customer/login', { body: { email: OWNER, password: 'not the password' } })).status).toBe(401);
    expect((await req('POST', '/api/v1/customer/login', { body: { email: OWNER, password: OWNER_PW } })).status).toBe(429);
    env.hub.db.prepare('UPDATE customer_accounts SET locked_until = NULL').run(); // skip the 15 minutes
  });

  it('refuses a cross-site request that carries the customer cookie', async () => {
    const res = await req('POST', `/api/v1/entities/${RELAY}/commands`, { cookie: ownerCookie, origin: 'https://evil.example', body: { commandId: randomUUID(), value: false } });
    expect(res.status).toBe(403);
  });

  it('one address gets 10 sign-in attempts a minute', async () => {
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await req('POST', '/api/v1/customer/login', { ip: '192.0.2.7', body: { email: 'nobody@example.test', password: 'whatever it is' } })).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('a random or expired code is refused', async () => {
    expect((await req('POST', '/api/v1/customer/claim', { body: { code: 'ABCDE-FGHJK' } })).status).toBe(400);
  });
});

describe('family member', () => {
  const MEMBER = 'family@example.test';
  const MEMBER_PW = 'family password 1';
  let memberCookie = '';
  const inviteSecret = (to: string) => {
    const mail = mailbox.filter((m) => m.to === to).at(-1)!;
    const link = mail.text.match(/(https:\/\/\S+#invite=(\S+))/)!;
    expect(link[1]!.startsWith(`${ORIGIN}/#invite=`)).toBe(true);
    return decodeURIComponent(link[2]!);
  };

  it('the owner invites by email; the member signs up, signs in and gets only the granted devices', async () => {
    const invite = await req('POST', '/api/v1/customer/invitations', { cookie: ownerCookie, body: { email: MEMBER, devices: [] } });
    expect(invite.status, JSON.stringify(invite.body)).toBe(201);
    expect((await req('GET', '/api/v1/customer/invitations', { cookie: ownerCookie })).body).toEqual([expect.objectContaining({ email: MEMBER })]);
    expect(mailbox.at(-1)!.subject).toMatch(/invited/);

    memberCookie = await signUpAndIn(inviteSecret(MEMBER), MEMBER, MEMBER_PW, 'Family');
    expect((await req('GET', '/api/v1/devices', { cookie: memberCookie })).body).toEqual([]); // nothing granted
    expect((await req('POST', `/api/v1/entities/${RELAY}/commands`, { cookie: memberCookie, body: { commandId: randomUUID(), value: true } })).status).toBe(404); // out of scope looks like it does not exist
    expect((await req('POST', '/api/v1/customer/invitations', { cookie: memberCookie, body: { email: 'x@example.test', devices: '*' } })).status).toBe(403);

    // The owner grants the relay; it applies at once.
    const clients = (await req('GET', '/api/v1/clients', { cookie: ownerCookie })).body as Array<{ clientId: string; name: string }>;
    const member = clients.find((c) => c.name === 'Family')!;
    expect((await req('PUT', `/api/v1/clients/${member.clientId}/devices`, { cookie: ownerCookie, body: { devices: ['esp-relay-01'] } })).status).toBe(204);
    expect((await req('GET', '/api/v1/devices', { cookie: memberCookie })).body).toHaveLength(1);
  });

  it('an invitation link works once, only for the invited address, and opening it changes nothing', async () => {
    const res = await req('POST', '/api/v1/customer/invitations', { cookie: ownerCookie, body: { email: 'cousin@example.test', devices: [] } });
    expect(res.status).toBe(201);
    const secret = inviteSecret('cousin@example.test');
    const claim = await req('POST', '/api/v1/customer/claim', { body: { code: secret } });
    const wrong = await req('POST', '/api/v1/customer/signup', { cookie: claim.cookies[0], body: { email: 'other@example.test', name: 'X', password: MEMBER_PW } });
    expect(wrong.status).toBe(400);
    expect((await req('POST', '/api/v1/customer/claim', { body: { code: secret } })).status).toBe(400); // being set up in another browser
    expect((await req('POST', '/api/v1/customer/signup', { cookie: claim.cookies[0], body: { email: 'cousin@example.test', name: 'Cousin', password: MEMBER_PW } })).status).toBe(201);
    expect((await req('POST', '/api/v1/customer/claim', { body: { code: secret } })).status).toBe(400);
  });

  it('a removed member who is invited again accepts by signing in with the existing account', async () => {
    const clients = (await req('GET', '/api/v1/clients', { cookie: ownerCookie })).body as Array<{ clientId: string; name: string }>;
    const member = clients.find((c) => c.name === 'Family')!;
    expect((await req('DELETE', `/api/v1/clients/${member.clientId}`, { cookie: ownerCookie })).status).toBe(204);
    expect((await req('GET', '/api/v1/devices', { cookie: memberCookie })).status).toBe(401); // removal ends access at once
    expect((await req('POST', '/api/v1/customer/login', { body: { email: MEMBER, password: MEMBER_PW } })).status).toBe(401);

    expect((await req('POST', '/api/v1/customer/invitations', { cookie: ownerCookie, body: { email: MEMBER, devices: ['esp-relay-01'] } })).status).toBe(201);
    const claim = await req('POST', '/api/v1/customer/claim', { body: { code: inviteSecret(MEMBER) } });
    expect((await req('POST', '/api/v1/customer/signup', { cookie: claim.cookies[0], body: { email: MEMBER, name: 'Family', password: MEMBER_PW } })).status).toBe(409);
    const login = await req('POST', '/api/v1/customer/login', { cookie: claim.cookies[0], body: { email: MEMBER, password: MEMBER_PW, acceptInvitation: true } });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    memberCookie = login.cookies.find((c) => c.startsWith('voltax_customer='))!;
    expect((await req('GET', '/api/v1/devices', { cookie: memberCookie })).body).toHaveLength(1);
  });

  it('a failed invitation email leaves no usable invitation', async () => {
    failMail = true;
    try {
      const res = await req('POST', '/api/v1/customer/invitations', { cookie: ownerCookie, body: { email: 'aunt@example.test', devices: [] } });
      expect(res.status).toBe(503);
    } finally {
      failMail = false;
    }
    expect((await req('GET', '/api/v1/customer/invitations', { cookie: ownerCookie })).body.some((i: { email: string }) => i.email === 'aunt@example.test')).toBe(false);
  });
});

describe('forgotten password (owner and member alike)', () => {
  const codeFor = (to: string) => mailbox.filter((m) => m.to === to && /reset code/.test(m.subject)).at(-1)?.text.match(/\b(\d{6})\b/)?.[1];

  it('an unknown address gets the same answer and no email', async () => {
    const before = mailbox.length;
    const res = await req('POST', '/api/v1/customer/forgot', { body: { email: 'nobody@example.test' } });
    expect(res.status).toBe(200);
    expect(mailbox.length).toBe(before);
  });

  it('the emailed code sets a new password, ends existing sessions, and works once', async () => {
    expect((await req('POST', '/api/v1/customer/forgot', { body: { email: OWNER } })).status).toBe(200);
    const code = codeFor(OWNER)!;
    expect(code).toMatch(/^\d{6}$/);
    const NEW_PW = 'brand new password 9';
    expect((await req('POST', '/api/v1/customer/reset', { body: { email: OWNER, code: code === '000000' ? '000001' : '000000', password: NEW_PW } })).status).toBe(400);
    expect((await req('POST', '/api/v1/customer/reset', { body: { email: OWNER, code, password: NEW_PW } })).status).toBe(200);
    expect((await req('GET', '/api/v1/devices', { cookie: ownerCookie })).status).toBe(401); // old sessions ended
    expect((await req('POST', '/api/v1/customer/login', { body: { email: OWNER, password: OWNER_PW } })).status).toBe(401);
    expect((await req('POST', '/api/v1/customer/login', { body: { email: OWNER, password: NEW_PW } })).status).toBe(200);
    expect((await req('POST', '/api/v1/customer/reset', { body: { email: OWNER, code, password: 'yet another password' } })).status).toBe(400);
  });

  it('five wrong codes use the code up, even before the right one is tried', async () => {
    env.hub.db.prepare('DELETE FROM customer_recovery').run();
    expect((await req('POST', '/api/v1/customer/forgot', { body: { email: 'family@example.test' } })).status).toBe(200);
    const code = codeFor('family@example.test')!;
    const wrong = code === '123456' ? '654321' : '123456';
    for (let i = 0; i < 5; i++) await req('POST', '/api/v1/customer/reset', { body: { email: 'family@example.test', code: wrong, password: 'another password 1' } });
    expect((await req('POST', '/api/v1/customer/reset', { body: { email: 'family@example.test', code, password: 'another password 1' } })).status).toBe(400);
  });

  it('codes and passwords never reach the hub audit log', async () => {
    const audit = JSON.stringify(env.hub.db.prepare('SELECT * FROM audit_log').all());
    for (const secret of [OWNER_PW, 'family password 1', ...mailbox.map((m) => m.text.match(/\b\d{6}\b/)?.[0]).filter(Boolean)]) expect(audit).not.toContain(secret);
    expect(randomBytes(1)).toBeTruthy();
  });
});
