import { z } from 'zod';
import { hubIdSchema, type Telemetry } from './cloud.js';
import { PLATFORM_ROLES, type PlatformRole } from './permissions.js';

// Company portal API (backend/cloud <-> frontend/admin). Operational metadata only.

export const PASSWORD_MIN = 12;
const password = z.string().min(PASSWORD_MIN, `at least ${PASSWORD_MIN} characters`).max(256);
const totpCode = z.string().regex(/^\d{6}$/, '6 digits');

export const loginSchema = z.object({ email: z.email().max(254), password: z.string().min(1).max(256), code: totpCode.optional() });
export const setupSchema = z.object({ token: z.string().min(20).max(128), password });
export const totpConfirmSchema = z.object({ code: totpCode });
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
  mfaEnrolled: boolean;
  setupComplete: boolean;
  disabled: boolean;
  locked: boolean;
  createdAt: number;
}

export interface MeView {
  staff: StaffView;
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
