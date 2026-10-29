// Single source of truth for who may do what. Used by the cloud API, the hub API and the tests that
// enumerate every role x action. Anything not listed here is denied (deny-by-default).
// Human-readable version: docs/security/permission-matrix.md.

export const PLATFORM_ROLES = ['PLATFORM_SUPER_ADMIN', 'PLATFORM_SUPPORT', 'INSTALLER'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const HOME_ROLES = ['HOME_OWNER', 'FAMILY_MEMBER'] as const;
export type HomeRole = (typeof HOME_ROLES)[number];

/**
 * How far a platform permission reaches:
 * - platform: any home (company operations; never device control or household data)
 * - assigned: only homes the staff member is explicitly assigned to (and the assignment is current)
 * - grant:    assigned AND an owner-approved, active support grant that names this action and resource
 * - own:      only records the staff member created (e.g. revoking their own grant)
 */
export type PlatformScope = 'platform' | 'assigned' | 'grant' | 'own';

export const PLATFORM_ACTIONS = [
  'staff.read',
  'staff.manage', // create/disable staff, change roles, reset MFA
  'assignment.manage',
  'home.onboard',
  'home.create',
  'home.update',
  'home.delete', // only a home that never went live: no connected hub, no support history
  'home.read', // operational metadata: name, hub id, connectivity, versions
  'home.contact.read', // owner notification contact
  'hub.register',
  'hub.read', // connectivity, version, sync health, update status
  'device.read', // device id + online/offline only, never on/off state or history
  'installation.manage',
  'grant.request',
  'grant.read',
  'grant.revoke',
  'device.command',
  'diagnostics.read',
  'activity.read',
  'hub.restart',
  'hub.update',
  'firmware.read',
  'firmware.manage',
  'rollout.read',
  'rollout.manage',
  'notification.read',
  'audit.read',
  'audit.verify',
] as const;
export type PlatformAction = (typeof PLATFORM_ACTIONS)[number];

const SA: PlatformRole = 'PLATFORM_SUPER_ADMIN';
const SUP: PlatformRole = 'PLATFORM_SUPPORT';
const INS: PlatformRole = 'INSTALLER';

// Platform admins run the company, they do not get household control: no 'grant' scope for SA,
// and SA cannot request grants (separation of duties). Revoking only reduces access, so SA may do it.
export const PLATFORM_PERMISSIONS: Record<PlatformAction, Partial<Record<PlatformRole, PlatformScope>>> = {
  'staff.read': { [SA]: 'platform' },
  'staff.manage': { [SA]: 'platform' },
  'assignment.manage': { [SA]: 'platform' },
  'home.onboard': { [SA]: 'platform' },
  'home.create': { [SA]: 'platform' },
  'home.update': { [SA]: 'platform' },
  'home.delete': { [SA]: 'platform' },
  'home.read': { [SA]: 'platform', [SUP]: 'assigned', [INS]: 'assigned' },
  'home.contact.read': { [SUP]: 'assigned', [INS]: 'assigned' },
  'hub.register': { [SA]: 'platform', [INS]: 'assigned' },
  'hub.read': { [SA]: 'platform', [SUP]: 'assigned', [INS]: 'assigned' },
  'device.read': { [SA]: 'platform', [SUP]: 'assigned', [INS]: 'assigned' },
  'installation.manage': { [INS]: 'assigned' },
  'grant.request': { [SUP]: 'assigned', [INS]: 'assigned' },
  'grant.read': { [SA]: 'platform', [SUP]: 'assigned', [INS]: 'assigned' },
  'grant.revoke': { [SA]: 'platform', [SUP]: 'own', [INS]: 'own' },
  'device.command': { [SUP]: 'grant', [INS]: 'grant' },
  'diagnostics.read': { [SUP]: 'grant', [INS]: 'grant' },
  'activity.read': { [SUP]: 'grant' },
  'hub.restart': { [SUP]: 'grant', [INS]: 'grant' },
  'hub.update': { [SA]: 'platform' }, // fleet rollout; the hub still applies only under the owner's local update policy
  'firmware.read': { [SA]: 'platform', [SUP]: 'platform', [INS]: 'platform' },
  'firmware.manage': { [SA]: 'platform' },
  'rollout.read': { [SA]: 'platform', [SUP]: 'platform' },
  'rollout.manage': { [SA]: 'platform' },
  'notification.read': { [SA]: 'platform', [SUP]: 'assigned' },
  'audit.read': { [SA]: 'platform' },
  'audit.verify': { [SA]: 'platform' },
};

/** Actions an owner can approve in a support grant. Executed and re-checked on the hub. */
export const GRANT_ACTIONS = ['device.command', 'diagnostics.read', 'activity.read', 'hub.restart'] as const;
export type GrantAction = (typeof GRANT_ACTIONS)[number];

/** Never possible remotely, whatever the role or grant: only the owner, on the hub. */
export const LOCAL_ONLY_ACTIONS = ['factory.reset', 'owner.promote', 'grant.approve'] as const;

export function platformScope(role: PlatformRole, action: PlatformAction): PlatformScope | null {
  return PLATFORM_PERMISSIONS[action]?.[role] ?? null;
}

export function isPlatformRole(value: unknown): value is PlatformRole {
  return typeof value === 'string' && (PLATFORM_ROLES as readonly string[]).includes(value);
}

// --- Household (hub) permissions -------------------------------------------------------------

/** all = every device in the home; granted = only devices the owner granted to this member. */
export type HomeScope = 'all' | 'granted';

export const HOME_ACTIONS = [
  'device.read',
  'device.command',
  'device.manage', // rename, delete
  'schedule.read',
  'schedule.manage',
  'automation.read',
  'automation.manage',
  'events.read',
  'client.manage', // invite, revoke, set member devices, promote/demote
  'grant.approve', // approve, reject, revoke support grants
  'grant.read',
  'update.manage', // hub update policy and approvals
  'audit.read',
] as const;
export type HomeAction = (typeof HOME_ACTIONS)[number];

const OWNER: HomeRole = 'HOME_OWNER';
const MEMBER: HomeRole = 'FAMILY_MEMBER';

export const HOME_PERMISSIONS: Record<HomeAction, Partial<Record<HomeRole, HomeScope>>> = {
  'device.read': { [OWNER]: 'all', [MEMBER]: 'granted' },
  'device.command': { [OWNER]: 'all', [MEMBER]: 'granted' },
  'device.manage': { [OWNER]: 'all' },
  'schedule.read': { [OWNER]: 'all', [MEMBER]: 'granted' },
  'schedule.manage': { [OWNER]: 'all' },
  'automation.read': { [OWNER]: 'all', [MEMBER]: 'granted' },
  'automation.manage': { [OWNER]: 'all' },
  'events.read': { [OWNER]: 'all', [MEMBER]: 'granted' },
  'client.manage': { [OWNER]: 'all' },
  'grant.approve': { [OWNER]: 'all' },
  'grant.read': { [OWNER]: 'all', [MEMBER]: 'all' }, // members see that a support session is active
  'update.manage': { [OWNER]: 'all' },
  'audit.read': { [OWNER]: 'all' },
};

export function homeScope(role: HomeRole, action: HomeAction): HomeScope | null {
  return HOME_PERMISSIONS[action]?.[role] ?? null;
}

/** The hub stores roles as owner/member; these are the household roles of the platform model. */
export function homeRoleOf(hubRole: 'owner' | 'member'): HomeRole {
  return hubRole === 'owner' ? OWNER : MEMBER;
}
