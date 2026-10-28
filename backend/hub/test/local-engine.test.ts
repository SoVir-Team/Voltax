import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUTTON, RELAY, pairOwner, startEnv, waitFor, type TestEnv } from './helpers.js';

let env: TestEnv;
let owner: { authorization: string };
beforeEach(async () => {
  env = await startEnv();
  owner = await pairOwner(env.hub);
});
afterEach(async () => env.close());

describe('schedules (run on the hub, no cloud)', () => {
  it('fires and switches the relay', async () => {
    const res = await env.hub.app.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      headers: owner,
      payload: { name: 'every second', cron: '* * * * * *', entityId: RELAY, value: true },
    });
    expect(res.statusCode).toBe(201);
    await waitFor(() => env.device.relay === true, 4000);
    expect(env.hub.events.since(0).some((e) => e.type === 'schedule.fired')).toBe(true);
  });

  it('rejects invalid cron expressions', async () => {
    const res = await env.hub.app.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      headers: owner,
      payload: { name: 'bad', cron: 'not a cron', entityId: RELAY, value: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it('does not fire when disabled, and bumps version on update', async () => {
    const created = (
      await env.hub.app.inject({
        method: 'POST',
        url: '/api/v1/schedules',
        headers: owner,
        payload: { name: 'off', cron: '* * * * * *', entityId: RELAY, value: true, enabled: false },
      })
    ).json<{ scheduleId: string; version: number }>();
    await new Promise((r) => setTimeout(r, 1500));
    expect(env.device.relay).toBe(false);
    const updated = await env.hub.app.inject({
      method: 'PUT',
      url: `/api/v1/schedules/${created.scheduleId}`,
      headers: owner,
      payload: { name: 'off', cron: '0 7 * * *', entityId: RELAY, value: true, enabled: true, version: created.version },
    });
    expect(updated.json<{ version: number }>().version).toBe(created.version + 1);
  });

  it('refuses targets that do not exist or are not switches', async () => {
    for (const entityId of ['ghost.switch.relay_9', BUTTON]) {
      const res = await env.hub.app.inject({ method: 'POST', url: '/api/v1/schedules', headers: owner, payload: { name: 'x', cron: '0 7 * * *', entityId, value: true } });
      expect(res.statusCode, entityId).toBe(400);
    }
  });

  it('an update must name the version it edits; a stale one is a conflict (409)', async () => {
    const created = (
      await env.hub.app.inject({ method: 'POST', url: '/api/v1/schedules', headers: owner, payload: { name: 'a', cron: '0 7 * * *', entityId: RELAY, value: true } })
    ).json<{ scheduleId: string; version: number }>();
    const put = (version?: number) =>
      env.hub.app.inject({ method: 'PUT', url: `/api/v1/schedules/${created.scheduleId}`, headers: owner, payload: { name: 'b', cron: '0 8 * * *', entityId: RELAY, value: true, version } });
    expect((await put()).statusCode).toBe(400);
    expect((await put(created.version)).statusCode).toBe(200);
    const stale = await put(created.version); // someone else saved in between
    expect(stale.statusCode).toBe(409);
    expect(env.hub.scheduler.get(created.scheduleId)!.cron).toBe('0 8 * * *');
  });
});

describe('automations (run on the hub, no cloud)', () => {
  const create = (action: object) =>
    env.hub.app.inject({
      method: 'POST',
      url: '/api/v1/automations',
      headers: owner,
      payload: { name: 'boot -> relay', trigger: { entityId: BUTTON, to: true }, action },
    });

  it('turns the relay on when the button is pressed, then reverts', async () => {
    expect((await create({ entityId: RELAY, value: true, revertAfterSeconds: 1 })).statusCode).toBe(201);
    await env.device.publishButton(true);
    await waitFor(() => env.device.relay === true);
    await waitFor(() => env.device.relay === false, 4000);
  });

  it('refuses an action on a non-switch and a trigger on an unknown entity', async () => {
    expect((await create({ entityId: BUTTON, value: true })).statusCode).toBe(400);
    const unknownTrigger = await env.hub.app.inject({
      method: 'POST',
      url: '/api/v1/automations',
      headers: owner,
      payload: { name: 'x', trigger: { entityId: 'ghost.binary_sensor.b', to: true }, action: { entityId: RELAY, value: true } },
    });
    expect(unknownTrigger.statusCode).toBe(400);
  });

  it('disabling or editing a rule cancels its pending revert; a stale edit is a conflict', async () => {
    const a = (await create({ entityId: RELAY, value: true, revertAfterSeconds: 1 })).json<{ automationId: string; version: number }>();
    await env.device.publishButton(true);
    await waitFor(() => env.device.relay === true);
    const put = (version: number) =>
      env.hub.app.inject({
        method: 'PUT',
        url: `/api/v1/automations/${a.automationId}`,
        headers: owner,
        payload: { name: 'boot -> relay', enabled: false, trigger: { entityId: BUTTON, to: true }, action: { entityId: RELAY, value: true, revertAfterSeconds: 1 }, version },
      });
    expect((await put(a.version)).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 1500));
    expect(env.device.relay).toBe(true); // the revert was cancelled with the edit
    expect((await put(a.version)).statusCode).toBe(409);
  });

  it('does not trigger from retained snapshots or duplicate reports', async () => {
    await create({ entityId: RELAY, value: true });
    env.hub.automations.handleState({ entityId: BUTTON, value: true, retained: true, changed: true });
    env.hub.automations.handleState({ entityId: BUTTON, value: true, retained: false, changed: false });
    await new Promise((r) => setTimeout(r, 300));
    expect(env.hub.events.since(0).some((e) => e.type === 'automation.fired')).toBe(false);
    expect(env.device.relay).toBe(false);
  });

  it('requires an owner to manage automations', async () => {
    const invite = (await env.hub.app.inject({ method: 'POST', url: '/api/v1/pairing-codes', headers: owner, payload: { devices: '*' } })).json<{ code: string }>();
    const member = (
      await env.hub.app.inject({ method: 'POST', url: '/api/v1/pair', payload: { pairingCode: invite.code, clientName: 'kid' } })
    ).json<{ token: string }>();
    const res = await env.hub.app.inject({
      method: 'POST',
      url: '/api/v1/automations',
      headers: { authorization: `Bearer ${member.token}` },
      payload: { name: 'x', trigger: { entityId: BUTTON, to: true }, action: { entityId: RELAY, value: true } },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('events', () => {
  it('assigns strictly increasing seq numbers and replays after a given seq', async () => {
    const a = env.hub.events.append('hub.started', {});
    const b = env.hub.events.append('hub.started', {});
    expect(b.seq).toBe(a.seq + 1);
    const res = await env.hub.app.inject({ method: 'GET', url: `/api/v1/events?afterSeq=${a.seq}`, headers: owner });
    expect(res.json<Array<{ seq: number }>>().map((e) => e.seq)).toEqual([b.seq]);
  });
});
