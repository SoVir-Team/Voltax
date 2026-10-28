import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diagnosticsSchema, type Actor, type GrantView, type HubMessage } from '@voltax/contracts';
import { HUB_ID, RELAY, pairOwner, startEnv, waitFor, type TestEnv } from './helpers.js';

const cloud = generateKeyPairSync('ed25519');
const attacker = generateKeyPairSync('ed25519');
const pem = cloud.publicKey.export({ type: 'spki', format: 'pem' }).toString();

const support: Actor = { staffId: randomUUID(), role: 'PLATFORM_SUPPORT', displayName: 'Asha (support)' };
const otherSupport: Actor = { staffId: randomUUID(), role: 'PLATFORM_SUPPORT', displayName: 'Ravi (support)' };
const installer: Actor = { staffId: randomUUID(), role: 'INSTALLER', displayName: 'Kiran (installer)' };
const admin: Actor = { staffId: randomUUID(), role: 'PLATFORM_SUPER_ADMIN', displayName: 'Admin' };

let env: TestEnv;
let owner: { authorization: string; clientId: string };
let sent: HubMessage[];

function signed(body: Record<string, unknown>, opts: { key?: KeyObject; actor?: Actor; lifetimeMs?: number; issuedAt?: number; hubId?: string } = {}) {
  const issuedAt = opts.issuedAt ?? Date.now();
  const envelope = {
    v: 1,
    envelopeId: randomUUID(),
    hubId: opts.hubId ?? HUB_ID,
    issuedAt,
    expiresAt: issuedAt + (opts.lifetimeMs ?? 10_000),
    actor: opts.actor ?? support,
    ...body,
  };
  const payload = JSON.stringify(envelope);
  return { payload, sig: sign(null, Buffer.from(payload), opts.key ?? cloud.privateKey).toString('base64'), envelope };
}

function deliver(msg: { payload: string; sig: string }) {
  env.hub.grants.handle({ payload: msg.payload, sig: msg.sig });
}

const lastRejection = () => [...sent].reverse().find((m) => m.type === 'envelope.rejected') as Extract<HubMessage, { type: 'envelope.rejected' }> | undefined;

function requestGrant(opts: { actions?: string[]; deviceIds?: string[]; startsAt?: number; endsAt?: number; actor?: Actor } = {}): string {
  const grantId = randomUUID();
  const now = Date.now();
  deliver(
    signed(
      {
        type: 'grant.request',
        grant: {
          grantId,
          deviceIds: opts.deviceIds ?? ['esp-relay-01'],
          actions: opts.actions ?? ['device.command'],
          reason: 'Customer reports the relay does not respond',
          ticketRef: 'VTX-1042',
          startsAt: opts.startsAt ?? now,
          endsAt: opts.endsAt ?? now + 60 * 60_000,
        },
      },
      { actor: opts.actor ?? support },
    ),
  );
  return grantId;
}

const ownerPost = (url: string) => env.hub.app.inject({ method: 'POST', url, headers: { authorization: owner.authorization } });
const approve = (grantId: string) => ownerPost(`/api/v1/support/grants/${grantId}/approve`);
const command = (grantId: string, value = true, actor: Actor = support, entityId = RELAY, commandId = randomUUID()) => {
  deliver(signed({ type: 'command', grantId, commandId, entityId, value }, { actor }));
  return commandId;
};
const grant = (id: string) => env.hub.grants.get(id) as GrantView;

beforeEach(async () => {
  env = await startEnv({ cloudKeyPem: pem, timeSynced: true });
  owner = await pairOwner(env.hub);
  sent = [];
  env.hub.grants.setSink((m) => sent.push(m));
});
afterEach(async () => env.close());

describe('support grant lifecycle (owner approves on the hub)', () => {
  it('request -> pending -> owner approves -> start notice -> command runs -> owner revokes -> refused', async () => {
    const grantId = requestGrant();
    expect(grant(grantId).status).toBe('pending');
    expect(env.hub.events.since(0).some((e) => e.type === 'support.requested')).toBe(true);

    command(grantId);
    expect(lastRejection()?.reason).toBe('grant pending');
    expect(env.device.relay).toBe(false);

    const res = await approve(grantId);
    expect(res.statusCode).toBe(200);
    expect(grant(grantId).status).toBe('active');
    expect(grant(grantId).startNoticeAt).not.toBeNull();
    expect(env.hub.events.since(0).some((e) => e.type === 'support.started')).toBe(true);

    const commandId = command(grantId, true);
    await waitFor(() => env.device.relay === true);
    await waitFor(() => sent.some((m) => m.type === 'command.result' && m.commandId === commandId && m.status === 'confirmed'));

    expect((await ownerPost(`/api/v1/support/grants/${grantId}/revoke`)).statusCode).toBe(200);
    expect(grant(grantId).status).toBe('revoked');
    command(grantId, false);
    expect(lastRejection()?.reason).toBe('grant revoked');
    await new Promise((r) => setTimeout(r, 100));
    expect(env.device.relay).toBe(true); // nothing ran after revocation
    expect(env.hub.events.since(0).some((e) => e.type === 'support.ended')).toBe(true);
    expect(sent.some((m) => m.type === 'grant.status' && m.status === 'revoked')).toBe(true);
  });

  it('owner can reject; a rejected grant can never be used or re-approved', async () => {
    const grantId = requestGrant();
    expect((await ownerPost(`/api/v1/support/grants/${grantId}/reject`)).statusCode).toBe(200);
    expect(grant(grantId).status).toBe('rejected');
    expect((await approve(grantId)).statusCode).toBe(409);
    command(grantId);
    expect(lastRejection()?.reason).toBe('grant rejected');
  });

  it('members can see support sessions but cannot approve, reject or revoke', async () => {
    const grantId = requestGrant();
    const invite = await env.hub.app.inject({ method: 'POST', url: '/api/v1/pairing-codes', headers: owner, payload: { devices: '*' } });
    const member = await env.hub.app.inject({ method: 'POST', url: '/api/v1/pair', payload: { pairingCode: invite.json<{ code: string }>().code, clientName: 'kid' } });
    const headers = { authorization: `Bearer ${member.json<{ token: string }>().token}` };
    expect((await env.hub.app.inject({ method: 'GET', url: '/api/v1/support/grants', headers })).statusCode).toBe(200);
    for (const action of ['approve', 'reject', 'revoke']) {
      expect((await env.hub.app.inject({ method: 'POST', url: `/api/v1/support/grants/${grantId}/${action}`, headers })).statusCode).toBe(403);
    }
    expect(grant(grantId).status).toBe('pending');
  });

  it('the cloud can end a grant (grantee or super admin) but nobody remote can approve one', async () => {
    const grantId = requestGrant();
    deliver(signed({ type: 'grant.approve', grantId }));
    expect(lastRejection()?.reason).toBe('malformed payload');
    expect(grant(grantId).status).toBe('pending');

    deliver(signed({ type: 'grant.revoke', grantId, reason: 'not mine' }, { actor: otherSupport }));
    expect(lastRejection()?.reason).toBe('not allowed to end this grant');
    deliver(signed({ type: 'grant.revoke', grantId, reason: 'withdrawn by admin' }, { actor: admin }));
    expect(grant(grantId).status).toBe('revoked');
  });

  it('expires on time and tells the owner', async () => {
    const grantId = requestGrant({ endsAt: Date.now() + 400 });
    await approve(grantId);
    await new Promise((r) => setTimeout(r, 450));
    command(grantId);
    expect(lastRejection()?.reason).toBe('grant expired');
    expect(grant(grantId).status).toBe('expired');
    expect(env.hub.events.since(0).some((e) => e.type === 'support.ended' && e.payload.status === 'expired')).toBe(true);
  });

  it('a session that starts later only starts (and notifies) when its window opens', async () => {
    const grantId = requestGrant({ startsAt: Date.now() + 300 });
    await approve(grantId);
    expect(grant(grantId).startNoticeAt).toBeNull();
    command(grantId);
    expect(lastRejection()?.reason).toBe('grant not started');
    await new Promise((r) => setTimeout(r, 350));
    env.hub.grants.sweep();
    expect(grant(grantId).startNoticeAt).not.toBeNull();
  });
});

describe('every cloud request is verified on the hub', () => {
  let active: string;
  beforeEach(async () => {
    active = requestGrant({ actions: ['device.command'] });
    await approve(active);
    sent = [];
  });

  const cases: Array<[string, () => void]> = [
    ['bad signature', () => deliver(signed({ type: 'command', grantId: active, commandId: randomUUID(), entityId: RELAY, value: true }, { key: attacker.privateKey }))],
    [
      'bad signature',
      () => {
        const m = signed({ type: 'command', grantId: active, commandId: randomUUID(), entityId: RELAY, value: false });
        deliver({ payload: m.payload.replace('"value":false', '"value":true'), sig: m.sig }); // tampered after signing
      },
    ],
    ['addressed to another hub', () => deliver(signed({ type: 'command', grantId: active, commandId: randomUUID(), entityId: RELAY, value: true }, { hubId: 'neighbour-hub' }))],
    ['expired', () => deliver(signed({ type: 'command', grantId: active, commandId: randomUUID(), entityId: RELAY, value: true }, { issuedAt: Date.now() - 20_000 }))],
    ['issued in the future', () => deliver(signed({ type: 'command', grantId: active, commandId: randomUUID(), entityId: RELAY, value: true }, { issuedAt: Date.now() + 120_000 }))],
    ['lifetime too long', () => deliver(signed({ type: 'command', grantId: active, commandId: randomUUID(), entityId: RELAY, value: true }, { lifetimeMs: 120_000 }))],
    ['malformed envelope', () => env.hub.grants.handle({ hello: 'world' })],
    ['unknown grant', () => command(randomUUID())],
    ['not the grantee', () => command(active, true, otherSupport)],
    ['not the grantee', () => command(active, true, installer)],
    ['role may not do this', () => command(active, true, admin)],
    ['device not granted', () => command(active, true, support, 'esp-relay-99.switch.relay_1')],
    ['action not granted', () => deliver(signed({ type: 'diagnostics.request', grantId: active, requestId: randomUUID() }))],
  ];

  for (const [reason, act] of cases) {
    it(`refuses: ${reason}`, () => {
      act();
      expect(lastRejection()?.reason).toBe(reason);
      expect(env.hub.commands.get(sent.find((m) => m.type === 'command.result')?.commandId ?? 'none')).toBeNull();
    });
  }

  it('refuses a replayed envelope', async () => {
    const m = signed({ type: 'command', grantId: active, commandId: randomUUID(), entityId: RELAY, value: true });
    deliver(m);
    await waitFor(() => env.device.relay === true);
    deliver(m);
    expect(lastRejection()?.reason).toBe('replayed');
  });

  it('refuses everything while the hub clock is not synchronised (fail-closed)', async () => {
    const unsynced = await startEnv({ cloudKeyPem: pem, timeSynced: false, connectDevice: false });
    const out: HubMessage[] = [];
    unsynced.hub.grants.setSink((m) => out.push(m));
    unsynced.hub.grants.handle(signed({ type: 'command', grantId: active, commandId: randomUUID(), entityId: RELAY, value: true }));
    expect(out).toContainEqual(expect.objectContaining({ type: 'envelope.rejected', reason: 'hub clock not synchronised' }));
    await unsynced.close();
  });

  it('refuses everything when no cloud key is installed', async () => {
    const plain = await startEnv({ timeSynced: true, connectDevice: false });
    const out: HubMessage[] = [];
    plain.hub.grants.setSink((m) => out.push(m));
    plain.hub.grants.handle(signed({ type: 'command', grantId: active, commandId: randomUUID(), entityId: RELAY, value: true }));
    expect(out).toContainEqual(expect.objectContaining({ type: 'envelope.rejected', reason: 'cloud link not configured' }));
    await plain.close();
  });

  it('refuses a session whose start notice is missing', () => {
    env.hub.db.prepare('UPDATE support_grants SET start_notice_at = NULL WHERE grant_id = ?').run(active);
    command(active);
    expect(lastRejection()?.reason).toBe('owner has not been notified');
  });

  it('executes a duplicate commandId only once', async () => {
    const id = randomUUID();
    command(active, true, support, RELAY, id);
    await waitFor(() => env.device.relay === true);
    await env.hub.commands.drain();
    command(active, true, support, RELAY, id);
    const sends = env.hub.events.since(0).filter((e) => e.type === 'command.status' && e.payload.commandId === id && e.payload.status === 'sent');
    expect(sends).toHaveLength(1);
  });
});

describe('grant requests are limited by role', () => {
  it('super admins cannot request access; installers cannot get household activity; devices must exist', () => {
    requestGrant({ actor: admin });
    expect(lastRejection()?.reason).toBe('role may not request support access');
    requestGrant({ actor: installer, actions: ['activity.read'] });
    expect(lastRejection()?.reason).toBe('role may not be granted activity.read');
    requestGrant({ deviceIds: ['no-such-device'] });
    expect(lastRejection()?.reason).toBe('unknown device');
    expect(env.hub.grants.list()).toHaveLength(0);
  });
});

describe('revocation and commands in flight', () => {
  it('cancels queued commands; reports the one already sent to the device; never publishes after revoke', async () => {
    const grantId = requestGrant();
    await approve(grantId);
    env.device.ignoreCommands = true; // the first command stays in flight (no confirmation)
    const first = command(grantId, true);
    await waitFor(() => env.hub.commands.get(first)?.status === 'sent');
    const second = command(grantId, false);
    expect(env.hub.commands.get(second)?.status).toBe('pending');

    await ownerPost(`/api/v1/support/grants/${grantId}/revoke`);
    expect(env.hub.commands.get(second)?.status).toBe('failed');
    expect(env.hub.commands.get(second)?.reason).toBe('grant revoked');
    const inflight = env.hub.events.since(0).find((e) => e.type === 'support.inflight');
    expect(inflight?.payload.commands).toEqual([{ commandId: first, entityId: RELAY, value: true }]);

    const publishedValues = () => env.device.received.filter((r) => r.topic.endsWith('/command')).map((r) => r.payload);
    await waitFor(() => env.hub.commands.get(first)?.status === 'failed', 15_000);
    expect(publishedValues()).toEqual(['ON']); // the second command never reached the device
  }, 20_000);

  it('re-checks the grant immediately before dispatch', async () => {
    const grantId = requestGrant();
    await approve(grantId);
    env.device.ignoreCommands = true;
    const first = command(grantId, true);
    await waitFor(() => env.hub.commands.get(first)?.status === 'sent');
    const second = command(grantId, false);
    // Grant ended by some path that does not cancel the queue (e.g. a crash mid-revoke).
    env.hub.db.prepare("UPDATE support_grants SET status = 'revoked' WHERE grant_id = ?").run(grantId);
    await waitFor(() => env.hub.commands.get(second)?.status === 'failed', 15_000);
    expect(env.hub.commands.get(second)?.reason).toBe('grant no longer valid: grant revoked');
    expect(env.device.received.filter((r) => r.topic.endsWith('/command')).map((r) => r.payload)).toEqual(['ON']);
  }, 20_000);
});

describe('diagnostics and household data', () => {
  it('diagnostics contain operational metadata only', async () => {
    const grantId = requestGrant({ actions: ['diagnostics.read'] });
    await approve(grantId);
    deliver(signed({ type: 'diagnostics.request', grantId, requestId: randomUUID() }));
    const result = sent.find((m) => m.type === 'diagnostics.result') as Extract<HubMessage, { type: 'diagnostics.result' }>;
    expect(diagnosticsSchema.safeParse(result.diagnostics).success).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/"state"|schedule|automation|"name"/);
  });

  it('activity history needs its own grant and only covers granted devices', async () => {
    const cmdOnly = requestGrant();
    await approve(cmdOnly);
    deliver(signed({ type: 'activity.request', grantId: cmdOnly, requestId: randomUUID(), sinceMs: 3_600_000 }));
    expect(lastRejection()?.reason).toBe('action not granted');

    const withActivity = requestGrant({ actions: ['activity.read'] });
    await approve(withActivity);
    deliver(signed({ type: 'activity.request', grantId: withActivity, requestId: randomUUID(), sinceMs: 3_600_000 }));
    const result = sent.find((m) => m.type === 'activity.result') as Extract<HubMessage, { type: 'activity.result' }>;
    expect(result.events.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.events)).not.toContain('esp-relay-02');
    const audit = env.hub.audit.since(0).find((r) => r.action === 'activity.read');
    expect(audit?.details.events).toBe(result.events.length);
  });

  it('records the whole lifecycle in the hub audit log without breaking the chain', async () => {
    const grantId = requestGrant();
    await approve(grantId);
    command(grantId);
    command(grantId, true, otherSupport);
    await ownerPost(`/api/v1/support/grants/${grantId}/revoke`);
    const actions = env.hub.audit.since(0).map((r) => `${r.action}:${r.outcome}`);
    expect(actions).toEqual(
      expect.arrayContaining(['grant.request:ok', 'grant.approve:ok', 'grant.start_notice:ok', 'device.command:allowed', 'command:denied', 'grant.revoke:ok']),
    );
    expect(env.hub.audit.verify().ok).toBe(true);
  });
});
