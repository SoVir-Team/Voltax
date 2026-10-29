import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCloud, type TestCloud, type TestStaff } from './helpers.js';

// The admin generates the homeowner's first one-time code from the portal. The cloud only relays it:
// the hub creates the code, the cloud signs the request with the hub's fresh challenge, and the code is
// shown once to the admin and never stored in the cloud.

let c: TestCloud;
let admin: TestStaff;
let home: string;
const HUB = 'hub-onboard';
const url = () => `/api/v1/homes/${home}/onboarding`;

beforeAll(async () => {
  c = await startCloud();
  admin = await c.addStaff('PLATFORM_SUPER_ADMIN');
  home = await c.addHome('New home');
  await c.addHub(home, HUB);
});
afterAll(() => c.close());

describe('initial homeowner code', () => {
  it('reports whether the home hub can take a code', async () => {
    const res = await c.req('GET', url(), { cookie: admin.cookie });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true, claimed: false });
  });

  it('the hub makes the code; the cloud signs the request with its challenge and shows the code once', async () => {
    const res = await c.req('POST', url(), { cookie: admin.cookie, body: { email: 'Owner@Example.test' } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    expect(res.body.email).toBe('owner@example.test');
    const sent = c.hub.published.filter((p) => p.envelope.type === 'customer.onboard').at(-1)!;
    expect(sent.hubId).toBe(HUB);
    expect(sent.envelope).toMatchObject({ type: 'customer.onboard', email: 'owner@example.test', actor: { role: 'PLATFORM_SUPER_ADMIN' } });

    const plain = res.body.code.replace('-', '');
    for (const table of ['audit_log', 'homes', 'hubs', 'notifications']) {
      expect(JSON.stringify(await c.db.query(`SELECT * FROM ${table}`)), table).not.toContain(plain);
    }
  });

  it('never reuses a hub challenge: a second request waits for the hub to announce a new one', async () => {
    c.hub.answering = false; // the hub answers nothing, so no new challenge arrives
    try {
      await c.req('POST', url(), { cookie: admin.cookie, body: { email: 'owner@example.test' } }); // uses the fresh challenge, times out
      const again = await c.req('POST', url(), { cookie: admin.cookie, body: { email: 'owner@example.test' } });
      expect(again.status).toBe(503);
    } finally {
      c.hub.answering = true;
    }
    await c.route(HUB, { type: 'customer.ready', challenge: randomBytes(32).toString('base64url'), claimed: false });
    expect((await c.req('POST', url(), { cookie: admin.cookie, body: { email: 'owner@example.test' } })).status).toBe(200);
  }, 20_000);

  it('a home that already has an owner refuses a new code', async () => {
    await new Promise((r) => setTimeout(r, 100)); // the fake hub's announcement after the last code lands first
    await c.route(HUB, { type: 'customer.ready', challenge: randomBytes(32).toString('base64url'), claimed: true });
    const res = await c.req('POST', url(), { cookie: admin.cookie, body: { email: 'owner@example.test' } });
    expect(res.status).toBe(409);
    expect((await c.req('GET', url(), { cookie: admin.cookie })).body.claimed).toBe(true);
  });

  it('a home whose hub never announced itself is unavailable', async () => {
    const other = await c.addHome('Quiet home');
    await c.homes.registerHub(other, 'hub-quiet', admin.staffId);
    const res = await c.req('POST', `/api/v1/homes/${other}/onboarding`, { cookie: admin.cookie, body: { email: 'owner@example.test' } });
    expect(res.status).toBe(503);
    expect(c.hub.published.some((p) => p.hubId === 'hub-quiet')).toBe(false);
  });
});
