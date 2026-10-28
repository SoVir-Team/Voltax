import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  GRANT_ACTIONS,
  HOME_ACTIONS,
  HOME_ROLES,
  LOCAL_ONLY_ACTIONS,
  PLATFORM_ACTIONS,
  PLATFORM_ROLES,
  homeScope,
  platformScope,
} from './permissions.js';
import { MAX_GRANT_DURATION_MS, cloudEnvelopeSchema, grantRequestSchema, telemetrySchema } from './cloud.js';

describe('platform permissions', () => {
  it('denies anything not listed', () => {
    expect(platformScope('INSTALLER', 'audit.read')).toBeNull();
    expect(platformScope('PLATFORM_SUPPORT', 'staff.manage')).toBeNull();
    expect(platformScope('INSTALLER', 'nope' as never)).toBeNull();
  });

  it('never gives platform admins household control or grant-based access', () => {
    for (const action of PLATFORM_ACTIONS) {
      expect(platformScope('PLATFORM_SUPER_ADMIN', action)).not.toBe('grant');
    }
    for (const action of [...GRANT_ACTIONS, 'grant.request'] as const) {
      expect(platformScope('PLATFORM_SUPER_ADMIN', action)).toBeNull();
    }
  });

  it('allows device control and household data only through an approved grant', () => {
    for (const role of PLATFORM_ROLES) {
      for (const action of GRANT_ACTIONS) {
        const scope = platformScope(role, action);
        expect(scope === null || scope === 'grant').toBe(true);
      }
    }
  });

  it('never lets a platform role do a local-only action', () => {
    for (const role of PLATFORM_ROLES) for (const action of LOCAL_ONLY_ACTIONS) expect(platformScope(role, action as never)).toBeNull();
  });

  it('keeps audit reading restricted to platform admins', () => {
    expect(PLATFORM_ROLES.filter((r) => platformScope(r, 'audit.read'))).toEqual(['PLATFORM_SUPER_ADMIN']);
  });
});

describe('household permissions', () => {
  it('limits family members to granted devices and read/command only', () => {
    for (const action of HOME_ACTIONS) {
      const scope = homeScope('FAMILY_MEMBER', action);
      if (action === 'grant.read') expect(scope).toBe('all');
      else if (scope) expect(scope).toBe('granted');
    }
    expect(homeScope('FAMILY_MEMBER', 'client.manage')).toBeNull();
    expect(homeScope('FAMILY_MEMBER', 'grant.approve')).toBeNull();
  });

  it('gives the owner every household action', () => {
    for (const action of HOME_ACTIONS) expect(homeScope('HOME_OWNER', action)).toBe('all');
    expect(HOME_ROLES).toHaveLength(2);
  });
});

describe('cloud envelope schemas', () => {
  const now = Date.now();
  const actor = { staffId: randomUUID(), role: 'PLATFORM_SUPPORT' as const, displayName: 'Asha (support)' };
  const grant = {
    grantId: randomUUID(),
    deviceIds: ['esp-relay-01'],
    actions: ['device.command'],
    reason: 'Customer reports relay not responding',
    startsAt: now,
    endsAt: now + 60 * 60_000,
  };

  it('accepts a well-formed grant request and command', () => {
    const base = { v: 1, envelopeId: randomUUID(), hubId: 'voltax-hub-001', issuedAt: now, expiresAt: now + 10_000, actor };
    expect(cloudEnvelopeSchema.safeParse({ ...base, type: 'grant.request', grant }).success).toBe(true);
    const cmd = { ...base, type: 'command', grantId: grant.grantId, commandId: randomUUID(), entityId: 'esp-relay-01.switch.relay_1', value: true };
    expect(cloudEnvelopeSchema.safeParse(cmd).success).toBe(true);
  });

  it('rejects grants longer than 4 hours, empty or duplicated scopes, unknown actions', () => {
    expect(grantRequestSchema.safeParse({ ...grant, endsAt: now + MAX_GRANT_DURATION_MS + 1 }).success).toBe(false);
    expect(grantRequestSchema.safeParse({ ...grant, endsAt: now }).success).toBe(false);
    expect(grantRequestSchema.safeParse({ ...grant, deviceIds: [] }).success).toBe(false);
    expect(grantRequestSchema.safeParse({ ...grant, actions: ['device.command', 'device.command'] }).success).toBe(false);
    expect(grantRequestSchema.safeParse({ ...grant, actions: ['factory.reset'] }).success).toBe(false);
  });

  it('rejects envelopes with an unknown type or role', () => {
    const base = { v: 1, envelopeId: randomUUID(), hubId: 'voltax-hub-001', issuedAt: now, expiresAt: now + 10_000 };
    expect(cloudEnvelopeSchema.safeParse({ ...base, actor, type: 'factory.reset' }).success).toBe(false);
    expect(cloudEnvelopeSchema.safeParse({ ...base, actor: { ...actor, role: 'HOME_OWNER' }, type: 'grant.request', grant }).success).toBe(false);
  });

  it('telemetry is an allow-list: extra fields such as switch states are rejected', () => {
    const telemetry = {
      version: '0.2.0',
      uptime: 10,
      db: 'up',
      mqtt: 'up',
      timeSynced: true,
      devices: [{ deviceId: 'esp-relay-01', online: true }],
      update: { state: 'idle' },
      at: now,
    };
    expect(telemetrySchema.safeParse(telemetry).success).toBe(true);
    expect(telemetrySchema.safeParse({ ...telemetry, devices: [{ deviceId: 'esp-relay-01', online: true, state: true }] }).success).toBe(false);
    expect(telemetrySchema.safeParse({ ...telemetry, schedules: [] }).success).toBe(false);
  });
});
