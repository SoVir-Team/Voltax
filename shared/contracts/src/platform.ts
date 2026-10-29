import { z } from 'zod';
import { entityIdSchema } from './api.js';
import { deviceIdSchema, hubIdSchema, type GrantStatus, type Telemetry } from './cloud.js';
import { GRANT_ACTIONS, PLATFORM_ROLES, type GrantAction, type PlatformRole } from './permissions.js';

// Company portal API (backend/cloud <-> frontend/admin). Operational metadata only.

export const PASSWORD_MIN = 12;
const password = z.string().min(PASSWORD_MIN, `at least ${PASSWORD_MIN} characters`).max(256);

export const loginSchema = z.object({ email: z.email().max(254), password: z.string().min(1).max(256) });
export const setupSchema = z.object({ token: z.string().min(20).max(128), password });
export const passwordChangeSchema = z.object({ current: z.string().min(1).max(256), next: password });

export const staffCreateSchema = z.object({
  email: z.email().max(254),
  displayName: z.string().trim().min(1).max(80),
  role: z.enum(PLATFORM_ROLES),
});
export const staffUpdateSchema = z
  .object({ role: z.enum(PLATFORM_ROLES).optional(), disabled: z.boolean().optional(), displayName: z.string().trim().min(1).max(80).optional() })
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'nothing to change');

export const homeCreateSchema = z.object({ name: z.string().trim().min(1).max(80), ownerContact: z.email().max(254).nullable().optional() });
export const homeUpdateSchema = z
  .object({ name: z.string().trim().min(1).max(80).optional(), ownerContact: z.email().max(254).nullable().optional() })
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'nothing to change');
export const hubRegisterSchema = z.object({ hubId: hubIdSchema });

export const assignmentCreateSchema = z.object({
  staffId: z.uuid(),
  homeId: z.uuid(),
  expiresAt: z.number().int().positive().nullable().optional(),
});

export interface StaffView {
  staffId: string;
  email: string;
  displayName: string;
  role: PlatformRole;
  /** Legacy enrollment information; password-only sign-in does not use it. */
  mfaEnrolled: boolean;
  setupComplete: boolean;
  disabled: boolean;
  locked: boolean;
  createdAt: number;
}

export interface MeView {
  staff: StaffView;
  /** Legacy session information; never used to authorize access. */
  mfa: boolean;
  sessionExpiresAt: number;
}

export interface HubView {
  hubId: string;
  registeredAt: number;
  lastSeenAt: number | null;
  online: boolean;
  version: string | null;
  timeSynced: boolean | null;
  update: Telemetry['update'] | null;
  devicesOnline: number;
  devicesTotal: number;
}

export interface HomeView {
  homeId: string;
  name: string;
  createdAt: number;
  hub: HubView | null;
}

export interface AssignmentView {
  assignmentId: string;
  staffId: string;
  homeId: string;
  createdAt: number;
  createdBy: string;
  expiresAt: number | null;
}

/** Shown once after registering a hub; goes into the hub's hub.env (see the cloud-link runbook). */
export interface HubEnrolment {
  hubId: string;
  brokerUsername: string;
  brokerPassword: string;
  rotated: boolean;
  brokerUrl: string | null;
  commandPublicKeyPem: string | null;
}

export interface AuditRecordView {
  seq: number;
  id: string;
  at: number;
  actor: string;
  action: string;
  outcome: 'allowed' | 'denied' | 'ok' | 'error';
  target: string | null;
  homeId: string | null;
  details: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

// --- support access (cloud side) -----------------------------------------------------------------

export const grantCreateSchema = z
  .object({
    deviceIds: z.array(deviceIdSchema).min(1).max(50),
    actions: z.array(z.enum(GRANT_ACTIONS)).min(1),
    reason: z.string().trim().min(10, 'say why (at least 10 characters)').max(500),
    ticketRef: z.string().trim().min(1).max(64).optional(),
    startsAt: z.number().int().positive().optional(),
    durationMinutes: z.number().int().min(5).max(240),
  })
  .refine((g) => new Set(g.actions).size === g.actions.length && new Set(g.deviceIds).size === g.deviceIds.length, 'duplicate actions or devices');
export const grantRevokeSchema = z.object({ reason: z.string().trim().min(1).max(500), outcome: z.enum(['revoked', 'completed']).default('revoked') });
export const grantCommandSchema = z.object({ entityId: entityIdSchema, value: z.boolean() });
export const activityRequestSchema = z.object({ sinceMinutes: z.number().int().min(1).max(7 * 24 * 60) });

export interface CloudGrantView {
  grantId: string;
  homeId: string;
  hubId: string;
  staff: { staffId: string; role: PlatformRole; displayName: string };
  deviceIds: string[];
  actions: GrantAction[];
  reason: string;
  ticketRef: string | null;
  startsAt: number;
  endsAt: number;
  status: GrantStatus;
  requestedAt: number;
  startNoticeAt: number | null;
  /** Every owner start notice delivered: required (fail-closed) before control actions. */
  ownerNotified: boolean;
  endedAt: number | null;
  endReason: string | null;
}

export interface GrantCommandView {
  commandId: string;
  grantId: string;
  entityId: string;
  value: boolean;
  status: string;
  reason: string | null;
  requestedAt: number;
  updatedAt: number;
}

export interface NotificationView {
  id: string;
  grantId: string;
  kind: 'support.started' | 'support.ended';
  channel: 'in_app' | 'email';
  status: 'pending' | 'delivered' | 'failed' | 'cancelled';
  attempts: number;
  lastError: string | null;
  createdAt: number;
  deliveredAt: number | null;
}

// --- Web Push (staff portal) ---------------------------------------------------------------------

/**
 * Hosts of the browser push services. Servers (cloud and hub) send HTTP requests to subscription
 * endpoints, so only these are accepted: no server-side request forgery through a crafted subscription.
 */
export const PUSH_SERVICE_HOSTS = [/^fcm\.googleapis\.com$/, /\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/, /^web\.push\.apple\.com$/, /\.push\.apple\.com$/];

export const pushSubscriptionSchema = z.object({
  endpoint: z.url({ protocol: /^https$/ }).max(1000),
  keys: z.object({ p256dh: z.string().regex(/^[A-Za-z0-9_-]{80,100}$/), auth: z.string().regex(/^[A-Za-z0-9_-]{16,32}$/) }),
});
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>;
