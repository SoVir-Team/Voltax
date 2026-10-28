import { z } from 'zod';
import { commandStatusSchema, entityIdSchema } from './api.js';
import { GRANT_ACTIONS, PLATFORM_ROLES } from './permissions.js';

// Cloud <-> hub protocol (Milestone 2). The hub connects OUT to the cloud broker; nothing here is
// needed for the hub to work at home.
//
// Cloud -> hub messages are signed envelopes: { payload, sig } where payload is the exact JSON text
// that was signed (Ed25519, cloud command key) and sig is base64. The hub verifies the signature on
// the bytes it received, then parses the payload. Hub -> cloud messages are authenticated by the
// hub's own broker credential, whose ACL only allows its own topics.

export const ENVELOPE_VERSION = 1;
export const MAX_CLOCK_SKEW_MS = 30_000;
export const MAX_COMMAND_LIFETIME_MS = 30_000;
export const MAX_ENVELOPE_LIFETIME_MS = 5 * 60_000;
export const MAX_GRANT_DURATION_MS = 4 * 60 * 60_000;

export const hubIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/);
export const deviceIdSchema = z.string().regex(/^[a-z0-9_-]{1,64}$/i);
const epochMs = z.number().int().positive();

export const grantStatusSchema = z.enum(['pending', 'active', 'rejected', 'revoked', 'expired', 'completed']);
export type GrantStatus = z.infer<typeof grantStatusSchema>;

/** A support grant as stored on the hub (the authority) and mirrored by the cloud. */
export interface GrantView {
  grantId: string;
  staff: { staffId: string; role: (typeof PLATFORM_ROLES)[number]; displayName: string };
  deviceIds: string[];
  actions: Array<(typeof GRANT_ACTIONS)[number]>;
  reason: string;
  ticketRef: string | null;
  startsAt: number;
  endsAt: number;
  status: GrantStatus;
  requestedAt: number;
  decidedAt: number | null;
  startNoticeAt: number | null;
  endedAt: number | null;
  endReason: string | null;
}

export const actorSchema = z.object({
  staffId: z.uuid(),
  role: z.enum(PLATFORM_ROLES),
  displayName: z.string().trim().min(1).max(80),
});
export type Actor = z.infer<typeof actorSchema>;

export const grantRequestSchema = z
  .object({
    grantId: z.uuid(),
    deviceIds: z.array(deviceIdSchema).min(1).max(50),
    actions: z.array(z.enum(GRANT_ACTIONS)).min(1),
    reason: z.string().trim().min(10).max(500),
    ticketRef: z.string().trim().min(1).max(64).optional(),
    startsAt: epochMs,
    endsAt: epochMs,
  })
  .refine((g) => g.endsAt > g.startsAt && g.endsAt - g.startsAt <= MAX_GRANT_DURATION_MS, {
    message: 'grant window must be positive and at most 4 hours',
  })
  .refine((g) => new Set(g.actions).size === g.actions.length && new Set(g.deviceIds).size === g.deviceIds.length, {
    message: 'duplicate actions or devices',
  });
export type GrantRequest = z.infer<typeof grantRequestSchema>;

const envelopeBase = {
  v: z.literal(ENVELOPE_VERSION),
  envelopeId: z.uuid(), // single-use nonce
  hubId: hubIdSchema,
  issuedAt: epochMs,
  expiresAt: epochMs,
  actor: actorSchema,
};

export const cloudEnvelopeSchema = z.discriminatedUnion('type', [
  z.object({ ...envelopeBase, type: z.literal('grant.request'), grant: grantRequestSchema }),
  z.object({
    ...envelopeBase,
    type: z.literal('grant.revoke'),
    grantId: z.uuid(),
    reason: z.string().trim().min(1).max(500),
    // 'completed': the staff member finished the work; 'revoked': access withdrawn. Both end the grant.
    outcome: z.enum(['revoked', 'completed']).default('revoked'),
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('command'),
    grantId: z.uuid(),
    commandId: z.uuid(),
    entityId: entityIdSchema,
    value: z.boolean(),
  }),
  z.object({ ...envelopeBase, type: z.literal('diagnostics.request'), grantId: z.uuid(), requestId: z.uuid() }),
  z.object({
    ...envelopeBase,
    type: z.literal('activity.request'),
    grantId: z.uuid(),
    requestId: z.uuid(),
    sinceMs: z.number().int().min(60_000).max(7 * 24 * 60 * 60_000),
  }),
  z.object({ ...envelopeBase, type: z.literal('hub.restart'), grantId: z.uuid() }),
  z.object({
    ...envelopeBase,
    type: z.literal('hub.update'),
    rolloutId: z.uuid(),
    version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9a-z.]+)?$/i),
  }),
]);
export type CloudEnvelope = z.infer<typeof cloudEnvelopeSchema>;
export type CloudEnvelopeType = CloudEnvelope['type'];

export const signedEnvelopeSchema = z.object({
  payload: z.string().min(2).max(16_384),
  sig: z.string().min(1).max(256),
});
export type SignedEnvelope = z.infer<typeof signedEnvelopeSchema>;

/** Longest lifetime the hub accepts for an envelope type. Commands are short-lived on purpose. */
export function maxLifetimeMs(type: CloudEnvelopeType): number {
  return type === 'command' ? MAX_COMMAND_LIFETIME_MS : MAX_ENVELOPE_LIFETIME_MS;
}

// --- hub -> cloud ------------------------------------------------------------------------------

export const updateStateSchema = z.enum(['idle', 'awaiting_approval', 'requested', 'applying', 'done', 'failed', 'rolled_back']);
export type UpdateState = z.infer<typeof updateStateSchema>;

/**
 * Operational metadata only (allow-list, strict): never device names, on/off states, history,
 * schedules or routines.
 */
export const telemetrySchema = z
  .object({
    version: z.string().max(32),
    uptime: z.number().int().min(0),
    db: z.enum(['up', 'down']),
    mqtt: z.enum(['up', 'down']),
    timeSynced: z.boolean(),
    devices: z.array(z.object({ deviceId: deviceIdSchema, online: z.boolean() }).strict()).max(500),
    update: z.object({ state: updateStateSchema, version: z.string().max(32).optional() }).strict(),
    at: epochMs,
  })
  .strict();
export type Telemetry = z.infer<typeof telemetrySchema>;

export const diagnosticsSchema = z
  .object({
    version: z.string().max(32),
    uptime: z.number().int().min(0),
    db: z.enum(['up', 'down']),
    mqtt: z.enum(['up', 'down']),
    timeSynced: z.boolean(),
    devices: z
      .array(z.object({ deviceId: deviceIdSchema, online: z.boolean(), lastSeen: z.number().int().nullable() }).strict())
      .max(500),
    commandsLast24h: z.object({ confirmed: z.number().int(), failed: z.number().int(), expired: z.number().int() }).strict(),
    eventLogSeq: z.number().int().min(0),
  })
  .strict();
export type Diagnostics = z.infer<typeof diagnosticsSchema>;

export const hubAuditRecordSchema = z.object({
  seq: z.number().int().positive(),
  id: z.uuid(),
  at: epochMs,
  actor: z.string().max(128),
  action: z.string().max(64),
  outcome: z.enum(['allowed', 'denied', 'ok', 'error']),
  target: z.string().max(256).nullable(),
  details: z.record(z.string(), z.unknown()),
  prevHash: z.string().regex(/^[0-9a-f]{64}$/),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type HubAuditRecord = z.infer<typeof hubAuditRecordSchema>;

export const hubMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('grant.status'),
    grantId: z.uuid(),
    status: grantStatusSchema,
    at: epochMs,
    reason: z.string().max(200).optional(),
    startNoticeAt: epochMs.optional(),
  }),
  z.object({
    type: z.literal('command.result'),
    commandId: z.uuid(),
    grantId: z.uuid(),
    status: commandStatusSchema,
    reason: z.string().max(200).optional(),
  }),
  z.object({ type: z.literal('envelope.rejected'), envelopeId: z.uuid().optional(), reason: z.string().max(200) }),
  z.object({ type: z.literal('telemetry'), telemetry: telemetrySchema }),
  z.object({ type: z.literal('diagnostics.result'), requestId: z.uuid(), grantId: z.uuid(), diagnostics: diagnosticsSchema }),
  z.object({
    type: z.literal('activity.result'),
    requestId: z.uuid(),
    grantId: z.uuid(),
    events: z.array(z.object({ seq: z.number().int(), type: z.string().max(64), createdAt: epochMs, payload: z.record(z.string(), z.unknown()) })).max(1000),
  }),
  z.object({ type: z.literal('audit.batch'), records: z.array(hubAuditRecordSchema).max(500) }),
  z.object({ type: z.literal('update.status'), rolloutId: z.uuid().optional(), state: updateStateSchema, version: z.string().max(32).optional() }),
]);
export type HubMessage = z.infer<typeof hubMessageSchema>;

// --- topics on the cloud broker (separate from the home broker) ---------------------------------

export const CLOUD_TOPIC_ROOT = 'voltax-cloud';
/** cloud -> hub signed envelopes */
export const cloudDownTopic = (hubId: string) => `${CLOUD_TOPIC_ROOT}/${hubId}/down`;
/** hub -> cloud messages */
export const cloudUpTopic = (hubId: string) => `${CLOUD_TOPIC_ROOT}/${hubId}/up`;
