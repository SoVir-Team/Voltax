import { createServer, type AddressInfo, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyExportedObject } from '../src/audit-export.js';
import { SmtpEmail } from '../src/channels.js';
import { S3Store } from '../src/s3.js';
import { startCloud, type TestCloud, type TestStaff } from './helpers.js';

// Real delivery against local stand-ins for the external services (npm run test:services starts
// them): Mailpit for SMTP email, an S3-compatible server with Object Lock for the audit copy.
// Skipped in the normal unit run.
const smtpUrl = process.env.VOLTAX_TEST_SMTP_URL;
const mailpitApi = process.env.VOLTAX_TEST_MAILPIT_API;
const s3 = process.env.VOLTAX_TEST_S3_ENDPOINT
  ? { endpoint: process.env.VOLTAX_TEST_S3_ENDPOINT, region: 'us-east-1', bucket: process.env.VOLTAX_TEST_S3_BUCKET ?? 'voltax-audit', accessKeyId: process.env.VOLTAX_TEST_S3_KEY!, secretAccessKey: process.env.VOLTAX_TEST_S3_SECRET!, lockDays: 1 }
  : null;

const HUB = 'hub-services';
const request = { deviceIds: ['kitchen'], actions: ['device.command'], reason: 'customer reports the kitchen light flickers', durationMinutes: 30 };

describe.skipIf(!smtpUrl || !mailpitApi)('email through a real SMTP server (Mailpit)', () => {
  let c: TestCloud;
  let support: TestStaff;

  async function startGrant(ownerContact: string): Promise<{ home: string; grantId: string }> {
    const home = await c.addHome(`Home of ${ownerContact}`);
    await c.homes.update(home, { ownerContact }, 'system');
    await c.addHub(home, `${HUB}-${Math.random().toString(16).slice(2, 8)}`);
    await c.assign(support.staffId, home);
    const res = await c.req('POST', `/api/v1/homes/${home}/grants`, { cookie: support.cookie, body: request });
    expect(res.status).toBe(201);
    const [{ hub_id }] = (await c.db.query<{ hub_id: string }>('SELECT hub_id FROM hubs WHERE home_id = $1', [home])) as [{ hub_id: string }];
    await c.route(hub_id, { type: 'grant.status', grantId: res.body.grantId, status: 'active', at: Date.now(), startNoticeAt: Date.now() });
    return { home, grantId: res.body.grantId };
  }
  const emailNotice = async (home: string, grantId: string) =>
    ((await c.req('GET', `/api/v1/homes/${home}/grants/${grantId}/notifications`, { cookie: support.cookie })).body as Array<{ channel: string; status: string; lastError: string | null }>).find((n) => n.channel === 'email')!;

  beforeAll(async () => {
    c = await startCloud({ extra: { email: new SmtpEmail({ url: smtpUrl!, from: 'VOLTEX Support <support@voltex.example.test>' }) } });
    support = await c.addStaff('PLATFORM_SUPPORT', 'Meera Support');
  });
  afterAll(async () => {
    await c?.close();
  });

  it('the owner receives the start notice, and only then is control allowed', async () => {
    const { home, grantId } = await startGrant('owner.services@example.test');
    expect(await emailNotice(home, grantId)).toMatchObject({ status: 'delivered' });
    const list = (await (await fetch(`${mailpitApi}/api/v1/search?query=${encodeURIComponent('to:owner.services@example.test')}`)).json()) as { messages: Array<{ ID: string; Subject: string }> };
    expect(list.messages).toHaveLength(1);
    expect(list.messages[0]!.Subject).toMatch(/support session started/);
    const msg = (await (await fetch(`${mailpitApi}/api/v1/message/${list.messages[0]!.ID}`)).json()) as { Text: string; From: { Address: string } };
    expect(msg.From.Address).toBe('support@voltex.example.test');
    expect(msg.Text).toContain('Meera Support');
    expect(msg.Text).toContain('kitchen');
    expect(msg.Text).toMatch(/Revoke/);
    expect(msg.Text).not.toMatch(/password|token|secret/i);
    const cmd = await c.req('POST', `/api/v1/homes/${home}/grants/${grantId}/commands`, { cookie: support.cookie, body: { entityId: 'kitchen.switch.relay', value: true } });
    expect(cmd.status).toBe(202);
  });

  it('a recipient the server refuses (550) fails permanently; control stays blocked', async () => {
    const { home, grantId } = await startGrant('owner@refused.invalid'); // Mailpit only accepts @example.test
    const n = await emailNotice(home, grantId);
    expect(n).toMatchObject({ status: 'failed' });
    expect(n.lastError).toMatch(/smtp 5\d\d error/);
    const cmd = await c.req('POST', `/api/v1/homes/${home}/grants/${grantId}/commands`, { cookie: support.cookie, body: { entityId: 'kitchen.switch.relay', value: true } });
    expect(cmd.status).toBe(409);
  });

  it('a mail server that accepts connections but never answers times out; the notice stays pending for retry and control stays blocked', async () => {
    // Black hole: TCP accepted, no SMTP greeting ever.
    const sockets: Socket[] = [];
    const hole = createServer((s) => sockets.push(s));
    await new Promise<void>((resolve) => hole.listen(0, '127.0.0.1', resolve));
    const url = `smtp://127.0.0.1:${(hole.address() as AddressInfo).port}`;
    const down = await startCloud({ extra: { email: new SmtpEmail({ url, from: 'support@voltex.example.test', timeoutMs: 1000 }) } });
    try {
      const s = await down.addStaff('PLATFORM_SUPPORT');
      const home = await down.addHome('Unreachable mail');
      await down.addHub(home, HUB);
      await down.assign(s.staffId, home);
      const g = (await down.req('POST', `/api/v1/homes/${home}/grants`, { cookie: s.cookie, body: request })).body.grantId as string;
      await down.route(HUB, { type: 'grant.status', grantId: g, status: 'active', at: Date.now(), startNoticeAt: Date.now() });
      const n = ((await down.req('GET', `/api/v1/homes/${home}/grants/${g}/notifications`, { cookie: s.cookie })).body as Array<{ channel: string; status: string; lastError: string }>).find((x) => x.channel === 'email')!;
      expect(n).toMatchObject({ status: 'pending', lastError: 'smtp connection error' });
      expect((await down.req('POST', `/api/v1/homes/${home}/grants/${g}/commands`, { cookie: s.cookie, body: { entityId: 'kitchen.switch.relay', value: true } })).status).toBe(409);
    } finally {
      await down.close();
      for (const s of sockets) s.destroy();
      hole.close();
    }
  }, 15_000);
});

describe.skipIf(!s3)('audit copy in S3-compatible storage with Object Lock', () => {
  let c: TestCloud;
  let store: S3Store;

  beforeAll(async () => {
    store = new S3Store(s3!);
    await store.createBucket();
    c = await startCloud({ extra: { objectStore: store } });
  });
  afterAll(async () => {
    await c?.close();
  });

  it('exports the chain with a signed checkpoint; the copy verifies on its own and cannot be destroyed', async () => {
    const admin = await c.addStaff('PLATFORM_SUPER_ADMIN');
    for (let i = 0; i < 5; i++) await c.req('POST', '/api/v1/homes', { cookie: admin.cookie, body: { name: `Export home ${i}` } });
    const first = await c.auditExport.runOnce();
    expect(first).not.toBeNull();
    expect(await c.auditExport.cursor()).toBeGreaterThan(0);

    const text = (await store.get(first!.key))!;
    const check = verifyExportedObject(text);
    expect(check).toMatchObject({ ok: true, records: first!.records });
    expect(check.checkpoint?.headHash).toBe(check.head);
    // The signed checkpoint inside the copy verifies with the published key.
    const verify = await c.req('POST', '/api/v1/audit/verify', { cookie: admin.cookie });
    expect(verify.body).toMatchObject({ ok: true, problems: [] });

    // COMPLIANCE retention: the stored version cannot be deleted by anyone until it expires.
    const info = (await store.head(first!.key))!;
    expect(info.lockMode).toBe('COMPLIANCE');
    expect(Date.parse(info.retainUntil!)).toBeGreaterThan(Date.now());
    const del = await store.delete(first!.key, info.versionId!);
    expect(del.status).toBe(403);
    // A plain delete only adds a delete marker: the locked version is still there, unchanged.
    await store.delete(first!.key);
    expect(await store.get(first!.key, info.versionId!)).toBe(text);

    // The next export continues the chain exactly where the first stopped.
    await c.req('POST', '/api/v1/homes', { cookie: admin.cookie, body: { name: 'After export' } });
    const second = (await c.auditExport.runOnce())!;
    expect(verifyExportedObject((await store.get(second.key))!, check.head!)).toMatchObject({ ok: true });
  });
});
