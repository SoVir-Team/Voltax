import {
  parseEntityId,
  platformScope,
  type Actor,
  type CloudEnvelope,
  type CommandView,
  type Diagnostics,
  type GrantAction,
  type GrantStatus,
  type GrantView,
  type HubMessage,
} from '@voltax/contracts';
import type { AuditLog } from './audit.js';
import type { CommandManager } from './commands.js';
import type { DB } from './db.js';
import type { EnvelopeVerifier } from './envelope.js';
import type { EventLog } from './events.js';
import type { Store } from './store.js';

interface GrantRow {
  grant_id: string;
  staff_id: string;
  staff_role: GrantView['staff']['role'];
  staff_name: string;
  device_ids: string;
  actions: string;
  reason: string;
  ticket_ref: string | null;
  starts_at: number;
  ends_at: number;
  status: GrantStatus;
  requested_at: number;
  decided_by: string | null;
  decided_at: number | null;
  start_notice_at: number | null;
  ended_at: number | null;
  end_reason: string | null;
}

export interface SupportGrantDeps {
  db: DB;
  events: EventLog;
  audit: AuditLog;
  commands: CommandManager;
  store: Store;
  verifier: EnvelopeVerifier;
  diagnostics: () => Diagnostics;
  /** Hub restart requested under a grant (wired by the cloud link; default: refuse). */
  restart?: () => boolean;
  now?: () => number;
}

type EndStatus = Extract<GrantStatus, 'rejected' | 'revoked' | 'expired' | 'completed'>;

const SWEEP_INTERVAL_MS = 5_000;
const ACTIVITY_EVENT_TYPES = new Set(['entity.state', 'device.online', 'command.status', 'schedule.fired', 'automation.fired']);

/**
 * Support access, enforced on the hub. The owner approves a grant here; the cloud can ask and can
 * withdraw, but can never approve, widen, or extend. Every cloud request is checked against the
 * LOCAL grant record: status, time window, start notice, grantee, action and device.
 */
export class SupportGrants {
  private send: (msg: HubMessage) => void = () => {};
  private sweeper: NodeJS.Timeout | undefined;
  private now: () => number;

  constructor(private deps: SupportGrantDeps) {
    this.now = deps.now ?? Date.now;
    // Last check right before a cloud command is published (revocation/expiry since acceptance).
    deps.commands.setPreDispatch((cmd) => (cmd.grantId ? this.recheck(cmd) : null));
    // Report the outcome of every grant command to the cloud.
    deps.events.subscribe((e) => {
      if (e.type !== 'command.status') return;
      const cmd = e.payload as unknown as CommandView;
      if (cmd.grantId) {
        this.send({ type: 'command.result', commandId: cmd.commandId, grantId: cmd.grantId, status: cmd.status, ...(cmd.reason ? { reason: cmd.reason } : {}) });
      }
    });
  }

  /** Where hub -> cloud messages go (set by the cloud link). */
  setSink(send: (msg: HubMessage) => void): void {
    this.send = send;
  }

  start(): void {
    this.sweep();
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref();
  }

  stop(): void {
    clearInterval(this.sweeper);
  }

  list(): GrantView[] {
    return (this.deps.db.prepare('SELECT * FROM support_grants ORDER BY requested_at DESC LIMIT 200').all() as GrantRow[]).map(toView);
  }

  get(grantId: string): GrantView | null {
    const row = this.deps.db.prepare('SELECT * FROM support_grants WHERE grant_id = ?').get(grantId) as GrantRow | undefined;
    return row ? toView(row) : null;
  }

  // --- cloud -> hub ------------------------------------------------------------------------------

  /** Entry point for every message from the cloud. Never throws. */
  handle(raw: unknown): void {
    const checked = this.deps.verifier.check(raw);
    if (!checked.ok) {
      this.refuse('cloud', 'envelope', checked.reason, checked.envelopeId);
      return;
    }
    const env = checked.envelope;
    try {
      switch (env.type) {
        case 'grant.request':
          return this.request(env);
        case 'grant.revoke':
          return this.cloudRevoke(env);
        case 'command':
          return this.command(env);
        case 'diagnostics.request':
          return this.diagnostics(env);
        case 'activity.request':
          return this.activity(env);
        case 'hub.restart':
          return this.restart(env);
        case 'hub.update':
          return this.refuse(actorId(env.actor), env.type, 'hub updates are handled by the update service', env.envelopeId);
      }
    } catch (err) {
      this.refuse(actorId(env.actor), env.type, `hub error: ${(err as Error).message}`, env.envelopeId);
    }
  }

  private request(env: Extract<CloudEnvelope, { type: 'grant.request' }>): void {
    const g = env.grant;
    const actor = actorId(env.actor);
    if (platformScope(env.actor.role, 'grant.request') !== 'assigned') return this.refuse(actor, env.type, 'role may not request support access', env.envelopeId);
    const forbidden = g.actions.find((a) => platformScope(env.actor.role, a) !== 'grant');
    if (forbidden) return this.refuse(actor, env.type, `role may not be granted ${forbidden}`, env.envelopeId);
    const known = new Set(this.deps.store.listDevices().map((d) => d.deviceId));
    const unknown = g.deviceIds.find((d) => !known.has(d));
    if (unknown) return this.refuse(actor, env.type, 'unknown device', env.envelopeId);
    if (g.endsAt <= this.now()) return this.refuse(actor, env.type, 'grant window already over', env.envelopeId);

    const inserted = this.deps.db
      .prepare(
        `INSERT OR IGNORE INTO support_grants (grant_id, staff_id, staff_role, staff_name, device_ids, actions, reason, ticket_ref,
           starts_at, ends_at, status, requested_at, request_envelope_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        g.grantId,
        env.actor.staffId,
        env.actor.role,
        env.actor.displayName,
        JSON.stringify(g.deviceIds),
        JSON.stringify(g.actions),
        g.reason,
        g.ticketRef ?? null,
        g.startsAt,
        g.endsAt,
        this.now(),
        env.envelopeId,
      ).changes;
    if (inserted !== 1) return this.refuse(actor, env.type, 'grant already exists', env.envelopeId);

    const view = this.get(g.grantId)!;
    this.deps.audit.append({ actor, action: 'grant.request', outcome: 'ok', target: g.grantId, details: { actions: g.actions, deviceIds: g.deviceIds, startsAt: g.startsAt, endsAt: g.endsAt, ticketRef: g.ticketRef } });
    this.deps.events.append('support.requested', { grantId: g.grantId, staff: view.staff, actions: g.actions, deviceIds: g.deviceIds, reason: g.reason, startsAt: g.startsAt, endsAt: g.endsAt });
    this.report(view);
  }

  private cloudRevoke(env: Extract<CloudEnvelope, { type: 'grant.revoke' }>): void {
    const actor = actorId(env.actor);
    const g = this.get(env.grantId);
    if (!g) return this.refuse(actor, env.type, 'unknown grant', env.envelopeId);
    const scope = platformScope(env.actor.role, 'grant.revoke');
    const allowed = scope === 'platform' || (scope === 'own' && g.staff.staffId === env.actor.staffId);
    if (!allowed) return this.refuse(actor, env.type, 'not allowed to end this grant', env.envelopeId);
    if (!this.end(env.grantId, env.outcome === 'completed' && g.status === 'active' ? 'completed' : 'revoked', env.reason, actor)) {
      this.refuse(actor, env.type, `grant already ${g.status}`, env.envelopeId);
    }
  }

  private command(env: Extract<CloudEnvelope, { type: 'command' }>): void {
    const actor = actorId(env.actor);
    const ref = parseEntityId(env.entityId);
    const denied = ref ? this.authorize(env.actor, env.grantId, 'device.command', ref.deviceId) : 'unknown entity';
    if (denied) return this.refuse(actor, env.type, denied, env.envelopeId, { grantId: env.grantId, entityId: env.entityId, commandId: env.commandId });

    const result = this.deps.commands.submit({
      commandId: env.commandId,
      entityId: env.entityId,
      value: env.value,
      source: 'cloud',
      grantId: env.grantId,
      expiresAt: env.expiresAt,
    });
    if ('error' in result) return this.refuse(actor, env.type, result.error, env.envelopeId, { grantId: env.grantId, commandId: env.commandId });
    this.deps.audit.append({ actor, action: 'device.command', outcome: 'allowed', target: env.entityId, details: { grantId: env.grantId, commandId: env.commandId, value: env.value } });
    if (result.status === 200) {
      // Duplicate commandId: report the existing outcome, never execute twice.
      this.send({ type: 'command.result', commandId: env.commandId, grantId: env.grantId, status: result.command.status });
    }
  }

  private diagnostics(env: Extract<CloudEnvelope, { type: 'diagnostics.request' }>): void {
    const actor = actorId(env.actor);
    const denied = this.authorize(env.actor, env.grantId, 'diagnostics.read');
    if (denied) return this.refuse(actor, env.type, denied, env.envelopeId, { grantId: env.grantId });
    this.deps.audit.append({ actor, action: 'diagnostics.read', outcome: 'allowed', details: { grantId: env.grantId } });
    this.send({ type: 'diagnostics.result', requestId: env.requestId, grantId: env.grantId, diagnostics: this.deps.diagnostics() });
  }

  private activity(env: Extract<CloudEnvelope, { type: 'activity.request' }>): void {
    const actor = actorId(env.actor);
    const denied = this.authorize(env.actor, env.grantId, 'activity.read');
    if (denied) return this.refuse(actor, env.type, denied, env.envelopeId, { grantId: env.grantId });
    const devices = new Set(this.get(env.grantId)!.deviceIds);
    const events = this.deps.events
      .sinceTime(this.now() - env.sinceMs)
      .filter((e) => ACTIVITY_EVENT_TYPES.has(e.type))
      .filter((e) => {
        const p = e.payload;
        const deviceId = typeof p.deviceId === 'string' ? p.deviceId : typeof p.entityId === 'string' ? parseEntityId(p.entityId)?.deviceId : undefined;
        return deviceId !== undefined && devices.has(deviceId);
      })
      .slice(-1000)
      .map((e) => ({ seq: e.seq, type: e.type, createdAt: e.createdAt, payload: e.payload }));
    // Household data: every access is recorded with how much was shared.
    this.deps.audit.append({ actor, action: 'activity.read', outcome: 'allowed', details: { grantId: env.grantId, sinceMs: env.sinceMs, events: events.length } });
    this.send({ type: 'activity.result', requestId: env.requestId, grantId: env.grantId, events });
  }

  private restart(env: Extract<CloudEnvelope, { type: 'hub.restart' }>): void {
    const actor = actorId(env.actor);
    const denied = this.authorize(env.actor, env.grantId, 'hub.restart');
    if (denied) return this.refuse(actor, env.type, denied, env.envelopeId, { grantId: env.grantId });
    if (!this.deps.restart?.()) return this.refuse(actor, env.type, 'restart not available on this hub', env.envelopeId);
    this.deps.audit.append({ actor, action: 'hub.restart', outcome: 'allowed', details: { grantId: env.grantId } });
  }

  // --- owner (local API) -------------------------------------------------------------------------

  approve(grantId: string, clientId: string): 'ok' | 'not_found' | 'not_pending' | 'over' {
    const g = this.get(grantId);
    if (!g) return 'not_found';
    if (g.status !== 'pending') return 'not_pending';
    const now = this.now();
    if (g.endsAt <= now) {
      this.end(grantId, 'expired', 'window ended before approval', 'hub');
      return 'over';
    }
    const changed = this.deps.db
      .prepare("UPDATE support_grants SET status = 'active', decided_by = ?, decided_at = ? WHERE grant_id = ? AND status = 'pending'")
      .run(clientId, now, grantId).changes;
    if (changed !== 1) return 'not_pending';
    this.deps.audit.append({ actor: `client:${clientId}`, action: 'grant.approve', outcome: 'ok', target: grantId, details: { actions: g.actions, deviceIds: g.deviceIds, endsAt: g.endsAt } });
    this.maybeStart(grantId);
    this.report(this.get(grantId)!);
    return 'ok';
  }

  /** Owner declines a pending request. */
  reject(grantId: string, clientId: string): 'ok' | 'not_found' | 'not_pending' {
    const g = this.get(grantId);
    if (!g) return 'not_found';
    if (g.status !== 'pending') return 'not_pending';
    this.deps.db.prepare('UPDATE support_grants SET decided_by = ?, decided_at = ? WHERE grant_id = ?').run(clientId, this.now(), grantId);
    this.end(grantId, 'rejected', 'rejected by the owner', `client:${clientId}`);
    return 'ok';
  }

  /** A cloud request was refused: audit it and tell the cloud why (never the owner's data). */
  private refuse(actor: string, action: string, reason: string, envelopeId?: string, details?: Record<string, unknown>): void {
    this.deps.audit.append({ actor, action, outcome: 'denied', details: { reason, envelopeId, ...details } });
    this.send({ type: 'envelope.rejected', ...(envelopeId ? { envelopeId } : {}), reason });
  }

  /** Owner withdraws access (pending or active). Takes effect before this call returns. */
  revoke(grantId: string, clientId: string): 'ok' | 'not_found' | 'already_ended' {
    const g = this.get(grantId);
    if (!g) return 'not_found';
    return this.end(grantId, 'revoked', 'revoked by the owner', `client:${clientId}`) ? 'ok' : 'already_ended';
  }

  // --- checks ------------------------------------------------------------------------------------

  /** Returns why the actor may NOT do this now, or null when allowed. */
  authorize(actor: Actor, grantId: string, action: GrantAction, deviceId?: string): string | null {
    if (platformScope(actor.role, action) !== 'grant') return 'role may not do this';
    const g = this.get(grantId);
    if (!g) return 'unknown grant';
    if (g.staff.staffId !== actor.staffId || g.staff.role !== actor.role) return 'not the grantee';
    return this.grantRefusal(g, action, deviceId);
  }

  private recheck(cmd: CommandView): string | null {
    const g = this.get(cmd.grantId!);
    const ref = parseEntityId(cmd.entityId);
    if (!g || !ref) return 'grant no longer valid';
    const refusal = this.grantRefusal(g, 'device.command', ref.deviceId);
    return refusal ? `grant no longer valid: ${refusal}` : null;
  }

  private grantRefusal(g: GrantView, action: GrantAction, deviceId?: string): string | null {
    const now = this.now();
    if (g.status !== 'active') return `grant ${g.status}`;
    if (now < g.startsAt) return 'grant not started';
    if (now >= g.endsAt) {
      this.end(g.grantId, 'expired', 'time window ended', 'hub');
      return 'grant expired';
    }
    if (!g.startNoticeAt) return 'owner has not been notified';
    if (!g.actions.includes(action)) return 'action not granted';
    if (deviceId !== undefined && !g.deviceIds.includes(deviceId)) return 'device not granted';
    return null;
  }

  // --- lifecycle ---------------------------------------------------------------------------------

  /** Starts due sessions, expires ended ones, prunes old nonces. */
  sweep(): void {
    const now = this.now();
    const due = this.deps.db
      .prepare("SELECT grant_id FROM support_grants WHERE status IN ('pending', 'active') AND ends_at <= ?")
      .all(now) as Array<{ grant_id: string }>;
    for (const { grant_id } of due) this.end(grant_id, 'expired', 'time window ended', 'hub');
    const starting = this.deps.db
      .prepare("SELECT grant_id FROM support_grants WHERE status = 'active' AND start_notice_at IS NULL AND starts_at <= ?")
      .all(now) as Array<{ grant_id: string }>;
    for (const { grant_id } of starting) {
      this.maybeStart(grant_id);
      this.report(this.get(grant_id)!);
    }
    this.deps.verifier.pruneNonces();
  }

  /** In-app notice: the session starts only once the owner's app has been told. */
  private maybeStart(grantId: string): void {
    const now = this.now();
    const g = this.get(grantId);
    if (!g || g.status !== 'active' || g.startNoticeAt || now < g.startsAt) return;
    this.deps.db.prepare('UPDATE support_grants SET start_notice_at = ? WHERE grant_id = ?').run(now, grantId);
    this.deps.events.append('support.started', { grantId, staff: g.staff, actions: g.actions, deviceIds: g.deviceIds, endsAt: g.endsAt });
    this.deps.audit.append({ actor: 'hub', action: 'grant.start_notice', outcome: 'ok', target: grantId, details: { channel: 'in-app' } });
  }

  /**
   * Ends a pending or active grant. Queued commands are cancelled; commands already published to a
   * device cannot be recalled, so they are reported to the owner (support.inflight) and tracked.
   */
  private end(grantId: string, status: EndStatus, reason: string, actor: string): boolean {
    const now = this.now();
    const before = this.get(grantId);
    const changed = this.deps.db
      .prepare("UPDATE support_grants SET status = ?, ended_at = ?, end_reason = ? WHERE grant_id = ? AND status IN ('pending', 'active')")
      .run(status, now, reason, grantId).changes;
    if (changed !== 1 || !before) return false;

    const cancelled = this.deps.commands.cancelQueued((c) => c.grantId === grantId, `grant ${status}`);
    const inFlight = this.deps.commands.inFlightForGrant(grantId);
    this.deps.audit.append({ actor, action: `grant.${status === 'rejected' ? 'reject' : status === 'expired' ? 'expire' : status === 'completed' ? 'complete' : 'revoke'}`, outcome: 'ok', target: grantId, details: { reason, cancelledCommands: cancelled.length, inFlightCommands: inFlight.length } });
    if (inFlight.length) {
      this.deps.events.append('support.inflight', {
        grantId,
        commands: inFlight.map((c) => ({ commandId: c.commandId, entityId: c.entityId, value: c.value })),
        note: 'These commands were already sent to the device before access ended and may have taken effect.',
      });
    }
    this.deps.events.append('support.ended', { grantId, status, reason, staff: before.staff, wasActive: before.status === 'active' });
    this.report(this.get(grantId)!);
    return true;
  }

  private report(g: GrantView): void {
    this.send({
      type: 'grant.status',
      grantId: g.grantId,
      status: g.status,
      at: this.now(),
      ...(g.endReason ? { reason: g.endReason } : {}),
      ...(g.startNoticeAt ? { startNoticeAt: g.startNoticeAt } : {}),
    });
  }
}

function actorId(a: Actor): string {
  return `cloud:${a.staffId}`;
}

function toView(r: GrantRow): GrantView {
  return {
    grantId: r.grant_id,
    staff: { staffId: r.staff_id, role: r.staff_role, displayName: r.staff_name },
    deviceIds: JSON.parse(r.device_ids) as string[],
    actions: JSON.parse(r.actions) as GrantView['actions'],
    reason: r.reason,
    ticketRef: r.ticket_ref,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    status: r.status,
    requestedAt: r.requested_at,
    decidedAt: r.decided_at,
    startNoticeAt: r.start_notice_at,
    endedAt: r.ended_at,
    endReason: r.end_reason,
  };
}
