import { z } from 'zod';

// Local hub API v1 contract (/api/v1/*). Shared by the hub and every client.

export const entityIdSchema = z.string().regex(/^[a-z0-9_-]+\.(switch|binary_sensor)\.[a-z0-9_-]+$/i);

export const commandRequestSchema = z.object({
  commandId: z.uuid(),
  value: z.boolean(),
  ttlMs: z.number().int().min(1000).max(30000).optional(),
  // Absolute deadline (epoch ms) set by the issuer, e.g. the cloud. Past deadline => 410, never executed.
  expiresAt: z.number().int().positive().optional(),
});
export type CommandRequest = z.infer<typeof commandRequestSchema>;

export const commandStatusSchema = z.enum(['pending', 'sent', 'confirmed', 'failed', 'expired']);
export type CommandStatus = z.infer<typeof commandStatusSchema>;

export interface CommandView {
  commandId: string;
  entityId: string;
  value: boolean;
  source: 'local' | 'schedule' | 'automation' | 'cloud';
  status: CommandStatus;
  /** Set for cloud commands: the support grant they were authorised by. */
  grantId?: string;
  issuedAt: number;
  expiresAt: number;
  reason?: string;
}

export const pairRequestSchema = z.object({
  pairingCode: z.string().min(6).max(32),
  clientName: z.string().trim().min(1).max(64),
});
export type PairRequest = z.infer<typeof pairRequestSchema>;

export const renameSchema = z.object({ name: z.string().trim().min(1).max(64) });
export type RenameInput = z.infer<typeof renameSchema>;

export const roleSchema = z.enum(['owner', 'member']);
export type Role = z.infer<typeof roleSchema>;

/** Devices a member may see and control: '*' (every device, explicitly chosen) or a list of device ids. */
export const deviceGrantSchema = z.union([z.literal('*'), z.array(z.string().regex(/^[a-z0-9_-]{1,64}$/i)).max(200)]);
export type DeviceGrantInput = z.infer<typeof deviceGrantSchema>;

/** POST /pairing-codes: the owner must say which devices the new member gets. */
export const inviteSchema = z.object({ devices: deviceGrantSchema });
export const memberDevicesSchema = z.object({ devices: deviceGrantSchema });

export interface ClientView {
  clientId: string;
  name: string;
  role: Role;
  createdAt: number;
  revokedAt: number | null;
  /** Members only. */
  devices?: DeviceGrantInput;
}

export const scheduleInputSchema = z.object({
  name: z.string().trim().min(1).max(64),
  cron: z.string().trim().min(1).max(64), // 5/6-field cron, hub-local time zone
  entityId: entityIdSchema,
  value: z.boolean(),
  enabled: z.boolean().default(true),
});
export type ScheduleInput = z.infer<typeof scheduleInputSchema>;

export const automationInputSchema = z.object({
  name: z.string().trim().min(1).max(64),
  enabled: z.boolean().default(true),
  trigger: z.object({ entityId: entityIdSchema, to: z.boolean() }),
  action: z.object({
    entityId: entityIdSchema,
    value: z.boolean(),
    // Optional: set the opposite value again after N seconds ("on for 60 s").
    revertAfterSeconds: z.number().int().min(1).max(86400).optional(),
  }),
});
export type AutomationInput = z.infer<typeof automationInputSchema>;

export interface EntityView {
  entityId: string;
  deviceId: string;
  component: 'switch' | 'binary_sensor';
  name: string;
  /** Last state REPORTED by the device; null until the device has reported. */
  state: boolean | null;
  stateVersion: number;
  updatedAt: number | null;
}

export interface DeviceView {
  deviceId: string;
  name: string;
  online: boolean;
  lastSeen: number | null;
  entities: EntityView[];
}

export interface HealthView {
  status: 'ok' | 'degraded';
  version: string;
  hubId: string;
  db: 'up' | 'down';
  mqtt: 'up' | 'down';
  timeSynced: boolean;
  uptime: number;
}

export interface HubEvent {
  seq: number;
  id: string;
  type: HubEventType;
  payload: Record<string, unknown>;
  createdAt: number;
}

export type HubEventType =
  | 'entity.state'
  | 'device.online'
  | 'command.status'
  | 'schedule.fired'
  | 'automation.fired'
  | 'hub.started'
  | 'support.requested'
  | 'support.started'
  | 'support.ended'
  | 'support.inflight';

// WebSocket: client must send `auth` first; server then streams events.
export const wsClientMessageSchema = z.object({
  type: z.literal('auth'),
  token: z.string().min(1),
  resumeAfterSeq: z.number().int().min(0).optional(),
});
export type WsClientMessage = z.infer<typeof wsClientMessageSchema>;

export type WsServerMessage =
  | { type: 'ready'; lastSeq: number }
  | { type: 'event'; event: HubEvent }
  | { type: 'error'; error: string };
