import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NotificationError, RETRY_DELAYS_MS, type EmailChannel } from '../src/notifications.js';
import { startCloud, type TestCloud, type TestStaff } from './helpers.js';

// Fake email provider: each scenario scripts what the provider does.
type Behaviour = 'ok' | 'transient' | 'permanent' | 'leaky';
const provider = {
  behaviour: [] as Behaviour[],
  sent: [] as Array<{ to: string; subject: string; text: string }>,
};
const email: EmailChannel = {
  async send(m) {
    const b = provider.behaviour.shift() ?? 'ok';
    if (b === 'transient') throw new NotificationError('connection timed out', false);
    if (b === 'permanent') throw new NotificationError('smtp 550 error', true);
    if (b === 'leaky') throw new Error('auth failed for owner@example.test password=hunter2 token=abc');
    provider.sent.push(m);
  },
};

let c: TestCloud;
let home: string;
let support: TestStaff;
const HUB = 'hub-notify';
const req = { deviceIds: ['kitchen'], actions: ['device.command', 'diagnostics.read'], reason: 'customer says the kitchen light is stuck', durationMinutes: 60 };

async function grant(opts: { notice?: boolean } = {}): Promise<string> {
  await c.db.query("UPDATE grants SET status = 'revoked' WHERE staff_id = $1 AND status IN ('pending', 'active')", [support.staffId]);
  const res = await c.req('POST', `/api/v1/homes/${home}/grants`, { cookie: support.cookie, body: req });
  expect(res.status).toBe(201);
  await c.route(HUB, { type: 'grant.status', grantId: res.body.grantId, status: 'active', at: Date.now(), ...(opts.notice === false ? {} : { startNoticeAt: Date.now() }) });
  return res.body.grantId as string;
}

const command = (grantId: string) =>
  c.req('POST', `/api/v1/homes/${home}/grants/${grantId}/commands`, { cookie: support.cookie, body: { entityId: 'kitchen.switch.relay', value: true } });
const diagnostics = (grantId: string) => c.req('POST', `/api/v1/homes/${home}/grants/${grantId}/diagnostics`, { cookie: support.cookie });
const notices = async (grantId: string) => (await c.req('GET', `/api/v1/homes/${home}/grants/${grantId}/notifications`, { cookie: support.cookie })).body as Array<{ kind: string; channel: string; status: string; attempts: number; lastError: string | null }>;
const emailNotice = async (grantId: string, kind = 'support.started') => (await notices(grantId)).find((n) => n.channel === 'email' && n.kind === kind)!;
/** Moves pending retries to "due now" and runs the sender once. */
const retryNow = async () => {
  await c.db.query("UPDATE notifications SET next_attempt_at = 0 WHERE status = 'pending'");
  await c.notifications.runDue();
};

beforeAll(async () => {
  c = await startCloud({ extra: { email } });
  home = await c.addHome('Notify home'); // owner contact: owner@example.test
  await c.addHub(home, HUB);
  support = await c.addStaff('PLATFORM_SUPPORT', 'Asha Support');
  await c.assign(support.staffId, home);
});
afterAll(async () => {
  await c.close();
});
beforeEach(() => {
  provider.behaviour = [];
  provider.sent = [];
});

describe('owner notifications (fail-closed)', () => {
  it('delivered: the owner gets an email naming who, what and until when; then control is allowed', async () => {
    const g = await grant();
    expect(provider.sent).toHaveLength(1);
    const mail = provider.sent[0]!;
    expect(mail.to).toBe('owner@example.test');
    expect(mail.subject).toMatch(/support session started/);
    expect(mail.text).toContain('Asha Support');
    expect(mail.text).toContain('kitchen');
    expect(mail.text).toMatch(/Revoke/);
    expect((await notices(g)).map((n) => `${n.channel}:${n.status}`).sort()).toEqual(['email:delivered', 'in_app:delivered']);
    expect((await command(g)).status).toBe(202);
    // The address is dropped once delivered.
    const [row] = await c.db.query<{ recipient: string | null }>("SELECT recipient FROM notifications WHERE grant_id = $1 AND channel = 'email'", [g]);
    expect(row!.recipient).toBeNull();
  });

  it('delayed: a transient failure is retried; control stays blocked until delivery succeeds', async () => {
    provider.behaviour = ['transient'];
    const g = await grant();
    expect(await emailNotice(g)).toMatchObject({ status: 'pending', attempts: 1, lastError: 'connection timed out' });
    const blocked = await command(g);
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toMatch(/notification not delivered/);
    expect((await c.req('GET', `/api/v1/homes/${home}/grants/${g}`, { cookie: support.cookie })).body.ownerNotified).toBe(false);
    await retryNow();
    expect(await emailNotice(g)).toMatchObject({ status: 'delivered', attempts: 2 });
    expect((await command(g)).status).toBe(202);
  });

  it('outage: after every retry fails the notice is failed and control stays blocked; diagnostics only', async () => {
    provider.behaviour = Array(RETRY_DELAYS_MS.length + 1).fill('transient');
    const g = await grant();
    for (let i = 0; i < RETRY_DELAYS_MS.length; i++) await retryNow();
    expect(await emailNotice(g)).toMatchObject({ status: 'failed', attempts: RETRY_DELAYS_MS.length + 1 });
    expect((await command(g)).status).toBe(409);
    expect((await diagnostics(g)).status).toBe(200); // operational metadata only, never household control
  });

  it('permanent failure: no retries, blocked', async () => {
    provider.behaviour = ['permanent'];
    const g = await grant();
    expect(await emailNotice(g)).toMatchObject({ status: 'failed', attempts: 1 });
    await retryNow();
    expect(provider.sent).toHaveLength(0);
    expect((await command(g)).status).toBe(409);
  });

  it('expiry: a notice still pending when the window ends is cancelled, never sent late', async () => {
    provider.behaviour = ['transient'];
    const g = await grant();
    await c.db.query('UPDATE grants SET ends_at = $2 WHERE grant_id = $1', [g, Date.now() - 1]);
    await c.grants.sweep();
    await retryNow();
    expect(await emailNotice(g)).toMatchObject({ status: 'cancelled' });
    expect(provider.sent.filter((m) => m.subject.includes('started'))).toHaveLength(0);
  });

  it('revocation: pending start notice cancelled, the owner is told the session ended', async () => {
    provider.behaviour = ['transient'];
    const g = await grant();
    await c.route(HUB, { type: 'grant.status', grantId: g, status: 'revoked', at: Date.now(), reason: 'revoked by the owner' });
    await retryNow();
    expect(await emailNotice(g)).toMatchObject({ status: 'cancelled' });
    expect(await emailNotice(g, 'support.ended')).toMatchObject({ status: 'delivered' });
    expect(provider.sent.at(-1)!.subject).toMatch(/ended/);
    expect(provider.sent.at(-1)!.text).toContain('revoked by the owner');
  });

  it('connectivity loss: the hub never confirms the in-app notice, so nothing is sent and nothing is allowed', async () => {
    const g = await grant({ notice: false });
    expect(await notices(g)).toEqual([]);
    expect(provider.sent).toHaveLength(0);
    expect((await command(g)).status).toBe(409);
    expect((await diagnostics(g)).status).toBe(409); // the hub's own start notice is required for everything
  });

  it('provider errors are stored without addresses or credentials', async () => {
    provider.behaviour = ['leaky'];
    const g = await grant();
    const n = await emailNotice(g);
    expect(n.lastError).not.toContain('owner@example.test');
    expect(n.lastError).not.toContain('hunter2');
    expect(n.lastError).not.toContain('abc');
    const audit = JSON.stringify(await c.db.query('SELECT details FROM audit_log'));
    expect(audit).not.toContain('owner@example.test');
    expect(audit).not.toContain('hunter2');
  });

  it('a home without an owner contact relies on the in-app notice alone', async () => {
    await c.db.query('UPDATE homes SET owner_contact = NULL WHERE id = $1', [home]);
    try {
      const g = await grant();
      expect((await notices(g)).map((n) => n.channel)).toEqual(['in_app']);
      expect((await command(g)).status).toBe(202);
    } finally {
      await c.db.query("UPDATE homes SET owner_contact = 'owner@example.test' WHERE id = $1", [home]);
    }
  });
});
