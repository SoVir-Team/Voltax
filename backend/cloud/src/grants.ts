import { randomUUID } from 'node:crypto';
import {
  ENVELOPE_VERSION,
  MAX_COMMAND_LIFETIME_MS,
  MAX_ENVELOPE_LIFETIME_MS,
  MAX_GRANT_DURATION_MS,
  parseEntityId,
  platformScope,
  type Actor,
  type CloudGrantView,
  type GrantCommandView,
  type CloudEnvelope,
  type Diagnostics,
  type GrantAction,
  type GrantStatus,
  type HubMessage,
  type PlatformRole,
  type SignedEnvelope,
} from '@voltax/contracts';
import type { CloudAudit } from './audit.js';
import type { Db } from './db.js';
import { CloudError, badRequest, conflict, forbidden, notFound } from './errors.js';
import type { HomesService } from './homes.js';
import type { Notifications } from './notifications.js';
import type { EnvelopeSigner } from './signer.js';

/** Sends a signed envelope to a hub (cloud broker). */
export interface HubTransport {
  publish(hubId: string, envelope: SignedEnvelope): Promise<void>;
}

interface GrantRow {
  grant_id: string;
  home_id: string;
  hub_id: string;
  staff_id: string;
  staff_role: PlatformRole;
  display_name: string;
  device_ids: string;
  actions: string;
  reason: string;
  ticket_ref: string | null;
  starts_at: number;
  ends_at: number;
  status: GrantStatus;
  requested_at: number;
  start_notice_at: number | null;
  ended_at: number | null;
  end_reason: string | null;
}

const TERMINAL: GrantStatus[] = ['rejected', 'revoked', 'expired', 'completed'];
// Commands get a little less than the hub's 30 s limit so clock skew never makes them "too long".
const COMMAND_TTL_MS = MAX_COMMAND_LIFETIME_MS - 5_000;
const ENVELOPE_TTL_MS = MAX_ENVELOPE_LIFETIME_MS - 30_000;
export const RESULT_TIMEOUT_MS = 15_000;
const GRANT_SELECT = 'SELECT g.*, s.display_name FROM grants g JOIN staff s ON s.id = g.staff_id';

interface Pending<T> {
  resolve: (v: T) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Cloud side of support access. The cloud checks its own rules (role, assignment, grant mirror,
 * owner notice) before it signs anything, and the hub checks everything again independently: a
 * compromised or buggy cloud still cannot make a hub act outside an owner-approved grant.
 */
export class GrantService {
  private pending = new Map<string, Pending<unknown>>(); // requestId -> waiter
  private envelopeToRequest = new Map<string, string>();
  private listeners = new Set<(g: CloudGrantView) => void>();

  constructor(
    private db: Db,
    private audit: CloudAudit,
    private homes: HomesService,
    private notifications: Notifications,
    private signer: EnvelopeSigner | null,
    private transport: HubTransport | null,
    private now: () => number = Date.now,
  ) {}

  private sweeper: NodeJS.Timeout | undefined;
  /** How long diagnostics/activity requests wait for the hub. */
  resultTimeoutMs = RESULT_TIMEOUT_MS;

  start(): void {
    this.sweeper = setInterval(() => void this.sweep().catch(() => undefined), 10_000);
    this.sweeper.unref();
  }

  stop(): void {
    clearInterval(this.sweeper);
    for (const p of this.pending.values()) p.reject(new CloudError(503, 'shutting_down', 'server shutting down'));
  }

  /** Grants whose window is over end in the mirror too (the hub expires them on its own clock). */
  async sweep(): Promise<number> {
    const due = await this.db.query<{ grant_id: string; hub_id: string }>("SELECT grant_id, hub_id FROM grants WHERE status IN ('pending', 'active') AND ends_at <= $1", [this.now()]);
    for (const g of due) await this.onStatus(g.hub_id, { type: 'grant.status', grantId: g.grant_id, status: 'expired', at: this.now(), reason: 'time window ended' });
    return due.length;
  }

  onChange(listener: (g: CloudGrantView) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // --- staff actions -----------------------------------------------------------------------------

  async request(
    actor: Actor,
    homeId: string,
    input: { deviceIds: string[]; actions: GrantAction[]; reason: string; ticketRef?: string; startsAt?: number; durationMinutes: number },
  ): Promise<CloudGrantView> {
    this.requireLink();
    for (const a of input.actions) if (platformScope(actor.role, a) !== 'grant') throw forbidden(`${actor.role} may not be granted ${a}`);
    const hubId = await this.homes.hubOf(homeId);
    if (!hubId) throw conflict('this home has no hub registered');
    const known = new Set((await this.homes.devices(homeId)).map((d) => d.deviceId));
    if (known.size === 0) throw conflict('the hub has not reported its devices yet');
    const unknown = input.deviceIds.find((d) => !known.has(d));
    if (unknown) throw badRequest(`unknown device ${unknown}`);
    const now = this.now();
    const startsAt = input.startsAt ?? now;
    const endsAt = startsAt + input.durationMinutes * 60_000;
    if (startsAt < now - 60_000) throw badRequest('start time is in the past');
    if (endsAt - startsAt > MAX_GRANT_DURATION_MS) throw badRequest('support access lasts at most 4 hours');
    const [open] = await this.db.query("SELECT 1 FROM grants WHERE home_id = $1 AND staff_id = $2 AND status IN ('pending', 'active')", [homeId, actor.staffId]);
    if (open) throw conflict('you already have a pending or active request for this home');

    const grantId = randomUUID();
    const envelopeId = randomUUID();
    await this.db.query(
      `INSERT INTO grants (grant_id, home_id, hub_id, staff_id, staff_role, device_ids, actions, reason, ticket_ref, starts_at, ends_at, status, requested_at, request_envelope_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', $12, $13)`,
      [grantId, homeId, hubId, actor.staffId, actor.role, JSON.stringify(input.deviceIds), JSON.stringify(input.actions), input.reason, input.ticketRef ?? null, startsAt, endsAt, now, envelopeId],
    );
    await this.audit.append({
      actor: `staff:${actor.staffId}`,
      action: 'grant.request',
      outcome: 'ok',
      target: `grant:${grantId}`,
      homeId,
      details: { actions: input.actions, deviceIds: input.deviceIds, startsAt, endsAt, ticketRef: input.ticketRef ?? null },
    });
    await this.send(hubId, {
      ...this.base(actor, hubId, envelopeId, ENVELOPE_TTL_MS),
      type: 'grant.request',
      grant: { grantId, deviceIds: input.deviceIds, actions: input.actions, reason: input.reason, ...(input.ticketRef ? { ticketRef: input.ticketRef } : {}), startsAt, endsAt },
    });
    return this.get(homeId, grantId);
  }

  /** Staff end their own grant (or a super admin ends any). Only ever reduces access. */
  async revoke(actor: Actor, homeId: string, grantId: string, reason: string, outcome: 'revoked' | 'completed'): Promise<CloudGrantView> {
    this.requireLink();
    const g = await this.row(homeId, grantId);
    const scope = platformScope(actor.role, 'grant.revoke');
    if (!(scope === 'platform' || (scope === 'own' && g.staff_id === actor.staffId))) {
      await this.audit.append({ actor: `staff:${actor.staffId}`, action: 'grant.revoke', outcome: 'denied', target: `grant:${grantId}`, homeId, details: { reason: 'not the grantee' } });
      throw notFound(); // someone else's grant looks the same as no grant
    }
    if (TERMINAL.includes(g.status)) throw conflict(`grant already ${g.status}`);
    await this.audit.append({ actor: `staff:${actor.staffId}`, action: 'grant.revoke', outcome: 'ok', target: `grant:${grantId}`, homeId, details: { reason, outcome } });
    await this.send(g.hub_id, { ...this.base(actor, g.hub_id, randomUUID(), ENVELOPE_TTL_MS), type: 'grant.revoke', grantId, reason, outcome });
    return this.view(g);
  }

  async command(actor: Actor, homeId: string, grantId: string, entityId: string, value: boolean): Promise<GrantCommandView> {
    const g = await this.authorize(actor, homeId, grantId, 'device.command', parseEntityId(entityId)?.deviceId ?? null);
    const commandId = randomUUID();
    const envelopeId = randomUUID();
    const now = this.now();
    await this.db.query(
      "INSERT INTO grant_commands (command_id, grant_id, entity_id, value, status, requested_by, requested_at, updated_at, envelope_id) VALUES ($1, $2, $3, $4, 'sent', $5, $6, $6, $7)",
      [commandId, grantId, entityId, value, actor.staffId, now, envelopeId],
    );
    await this.audit.append({ actor: `staff:${actor.staffId}`, action: 'device.command', outcome: 'allowed', target: entityId, homeId, details: { grantId, commandId, value } });
    await this.send(g.hub_id, { ...this.base(actor, g.hub_id, envelopeId, COMMAND_TTL_MS), type: 'command', grantId, commandId, entityId, value });
    return (await this.commands(homeId, grantId)).find((c) => c.commandId === commandId)!;
  }

  async diagnostics(actor: Actor, homeId: string, grantId: string): Promise<Diagnostics> {
    const g = await this.authorize(actor, homeId, grantId, 'diagnostics.read', null);
    const requestId = randomUUID();
    const envelopeId = randomUUID();
    await this.audit.append({ actor: `staff:${actor.staffId}`, action: 'diagnostics.read', outcome: 'allowed', target: `grant:${grantId}`, homeId });
    return this.ask<Diagnostics>(requestId, envelopeId, () =>
      this.send(g.hub_id, { ...this.base(actor, g.hub_id, envelopeId, COMMAND_TTL_MS), type: 'diagnostics.request', grantId, requestId }),
    );
  }

  /** Household data passes through to the staff member and is never stored by the cloud. */
  async activity(actor: Actor, homeId: string, grantId: string, sinceMs: number): Promise<Extract<HubMessage, { type: 'activity.result' }>['events']> {
    const g = await this.authorize(actor, homeId, grantId, 'activity.read', null);
    const requestId = randomUUID();
    const envelopeId = randomUUID();
    const events = await this.ask<Extract<HubMessage, { type: 'activity.result' }>['events']>(requestId, envelopeId, () =>
      this.send(g.hub_id, { ...this.base(actor, g.hub_id, envelopeId, COMMAND_TTL_MS), type: 'activity.request', grantId, requestId, sinceMs }),
    );
    await this.audit.append({ actor: `staff:${actor.staffId}`, action: 'activity.read', outcome: 'allowed', target: `grant:${grantId}`, homeId, details: { sinceMs, events: events.length } });
    return events;
  }

  async restart(actor: Actor, homeId: string, grantId: string): Promise<void> {
    const g = await this.authorize(actor, homeId, grantId, 'hub.restart', null);
    await this.audit.append({ actor: `staff:${actor.staffId}`, action: 'hub.restart', outcome: 'allowed', target: `hub:${g.hub_id}`, homeId, details: { grantId } });
    await this.send(g.hub_id, { ...this.base(actor, g.hub_id, randomUUID(), COMMAND_TTL_MS), type: 'hub.restart', grantId });
  }

  // --- reads -------------------------------------------------------------------------------------

  async listForHome(homeId: string): Promise<CloudGrantView[]> {
    const rows = await this.db.query<GrantRow>(`${GRANT_SELECT} WHERE g.home_id = $1 ORDER BY g.requested_at DESC LIMIT 200`, [homeId]);
    return Promise.all(rows.map((r) => this.view(r)));
  }

  /** platform: every grant; otherwise grants in homes the staff member is currently assigned to. */
  async list(staffId: string, scope: 'platform' | 'assigned', filter: { status?: GrantStatus } = {}): Promise<CloudGrantView[]> {
    const rows =
      scope === 'platform'
        ? await this.db.query<GrantRow>(`${GRANT_SELECT} WHERE ($1::text IS NULL OR g.status = $1) ORDER BY g.requested_at DESC LIMIT 200`, [filter.status ?? null])
        : await this.db.query<GrantRow>(
            `${GRANT_SELECT} WHERE ($1::text IS NULL OR g.status = $1) AND g.home_id IN
               (SELECT a.home_id FROM assignments a WHERE a.staff_id = $2 AND a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at > $3))
             ORDER BY g.requested_at DESC LIMIT 200`,
            [filter.status ?? null, staffId, this.now()],
          );
    return Promise.all(rows.map((r) => this.view(r)));
  }

  async get(homeId: string, grantId: string): Promise<CloudGrantView> {
    return this.view(await this.row(homeId, grantId));
  }

  async commands(homeId: string, grantId: string): Promise<GrantCommandView[]> {
    await this.row(homeId, grantId);
    const rows = await this.db.query<{ command_id: string; grant_id: string; entity_id: string; value: boolean; status: string; reason: string | null; requested_at: number; updated_at: number }>(
      'SELECT * FROM grant_commands WHERE grant_id = $1 ORDER BY requested_at DESC LIMIT 200',
      [grantId],
    );
    return rows.map((r) => ({
      commandId: r.command_id,
      grantId: r.grant_id,
      entityId: r.entity_id,
      value: r.value,
      status: r.status,
      reason: r.reason,
      requestedAt: Number(r.requested_at),
      updatedAt: Number(r.updated_at),
    }));
  }

  // --- hub -> cloud ------------------------------------------------------------------------------

  /** Called for grant-related messages that arrived on hub `hubId`'s own (ACL-protected) topic. */
  async handleHubMessage(hubId: string, msg: HubMessage): Promise<void> {
    switch (msg.type) {
      case 'grant.status':
        return this.onStatus(hubId, msg);
      case 'command.result':
        await this.db.query(
          `UPDATE grant_commands c SET status = $3, reason = $4, updated_at = $5
           FROM grants g WHERE c.command_id = $1 AND c.grant_id = $2 AND g.grant_id = c.grant_id AND g.hub_id = $6`,
          [msg.commandId, msg.grantId, msg.status, msg.reason ?? null, this.now(), hubId],
        );
        return;
      case 'envelope.rejected':
        return this.onRejected(hubId, msg);
      case 'diagnostics.result':
        return this.settle(hubId, msg.requestId, msg.grantId, msg.diagnostics);
      case 'activity.result':
        return this.settle(hubId, msg.requestId, msg.grantId, msg.events);
      default:
        return;
    }
  }

  private async onStatus(hubId: string, msg: Extract<HubMessage, { type: 'grant.status' }>): Promise<void> {
    const ended = TERMINAL.includes(msg.status);
    // One transaction with the row locked: the grant and its waiting commands change together, and a
    // concurrent sweep or duplicate message cannot end the same grant twice.
    const g = await this.db.tx(async (t) => {
      const [row] = await t.query<GrantRow>(`${GRANT_SELECT} WHERE g.grant_id = $1 AND g.hub_id = $2 FOR UPDATE OF g`, [msg.grantId, hubId]);
      // Terminal states never change back; the hub is the authority on everything else.
      if (!row || (TERMINAL.includes(row.status) && row.status !== msg.status)) return row ? null : undefined;
      await t.query(
        'UPDATE grants SET status = $2, hub_updated_at = $3, start_notice_at = COALESCE(start_notice_at, $4), ended_at = COALESCE(ended_at, $5), end_reason = COALESCE(end_reason, $6) WHERE grant_id = $1',
        [msg.grantId, msg.status, msg.at, msg.startNoticeAt ?? null, ended ? msg.at : null, ended ? (msg.reason ?? msg.status) : null],
      );
      if (ended && !TERMINAL.includes(row.status)) {
        // Anything still waiting on this grant fails now rather than at its timeout.
        await t.query("UPDATE grant_commands SET status = 'failed', reason = $2, updated_at = $3 WHERE grant_id = $1 AND status = 'sent'", [msg.grantId, `grant ${msg.status}`, this.now()]);
      }
      return row;
    });
    if (g === undefined) {
      await this.audit.append({ actor: `hub:${hubId}`, action: 'grant.status', outcome: 'denied', target: `grant:${msg.grantId}`, details: { reason: 'unknown grant for this hub' } });
      return;
    }
    if (g === null) return;
    const noticedNow = msg.status === 'active' && msg.startNoticeAt && !g.start_notice_at;
    if (g.status !== msg.status || noticedNow) {
      await this.audit.append({ actor: `hub:${hubId}`, action: 'grant.status', outcome: 'ok', target: `grant:${msg.grantId}`, homeId: g.home_id, details: { from: g.status, to: msg.status, reason: msg.reason ?? null } });
    }
    const notice = await this.notice(msg.grantId);
    if (noticedNow) await this.notifications.onStarted(notice);
    if (ended && !TERMINAL.includes(g.status)) {
      await this.notifications.onEnded(notice, Boolean(g.start_notice_at || msg.startNoticeAt));
    }
    if (g.status !== msg.status) {
      const view = await this.get(g.home_id, g.grant_id);
      for (const l of this.listeners) l(view);
    }
  }

  private async onRejected(hubId: string, msg: Extract<HubMessage, { type: 'envelope.rejected' }>): Promise<void> {
    if (!msg.envelopeId) return;
    const requestId = this.envelopeToRequest.get(msg.envelopeId);
    if (requestId) {
      const p = this.pending.get(requestId);
      if (p) p.reject(new CloudError(409, 'hub_refused', `the hub refused: ${msg.reason}`));
      return;
    }
    const [grant] = await this.db.query<{ grant_id: string; home_id: string; status: GrantStatus }>(
      'SELECT grant_id, home_id, status FROM grants WHERE request_envelope_id = $1 AND hub_id = $2',
      [msg.envelopeId, hubId],
    );
    if (grant && grant.status === 'pending') {
      // The hub refused the request itself (e.g. unknown device): it never reached the owner.
      await this.onStatus(hubId, { type: 'grant.status', grantId: grant.grant_id, status: 'rejected', at: this.now(), reason: `hub refused: ${msg.reason}` });
      return;
    }
    await this.db.query(
      `UPDATE grant_commands c SET status = 'refused', reason = $2, updated_at = $3 FROM grants g
       WHERE c.envelope_id = $1 AND g.grant_id = c.grant_id AND g.hub_id = $4`,
      [msg.envelopeId, msg.reason, this.now(), hubId],
    );
  }

  // --- checks ------------------------------------------------------------------------------------

  /** The cloud's own gate before signing. The hub repeats every one of these checks. */
  private async authorize(actor: Actor, homeId: string, grantId: string, action: GrantAction, deviceId: string | null): Promise<GrantRow> {
    this.requireLink();
    const g = await this.row(homeId, grantId);
    const refuse = async (reason: string, status = 403) => {
      await this.audit.append({ actor: `staff:${actor.staffId}`, action, outcome: 'denied', target: `grant:${grantId}`, homeId, details: { reason } });
      throw new CloudError(status, 'grant_refused', reason);
    };
    if (platformScope(actor.role, action) !== 'grant') return refuse('role may not do this');
    if (g.staff_id !== actor.staffId || g.staff_role !== actor.role) return refuse('not the grantee');
    const now = this.now();
    if (g.status !== 'active') return refuse(`grant ${g.status}`, 409);
    if (now < Number(g.starts_at)) return refuse('grant not started', 409);
    if (now >= Number(g.ends_at)) return refuse('grant expired', 409);
    if (!g.start_notice_at) return refuse('owner has not been notified yet', 409);
    // Fail-closed: control actions need every owner notice delivered. Diagnostics are operational only.
    if (action !== 'diagnostics.read' && !(await this.notifications.startNoticeDelivered(grantId))) {
      return refuse('owner notification not delivered; control actions stay blocked', 409);
    }
    if (!(JSON.parse(g.actions) as string[]).includes(action)) return refuse('action not granted');
    if (action === 'device.command') {
      if (!deviceId) return refuse('unknown entity', 400);
      if (!(JSON.parse(g.device_ids) as string[]).includes(deviceId)) return refuse('device not granted');
    }
    return g;
  }

  private requireLink(): void {
    if (!this.signer || !this.transport) throw new CloudError(503, 'support_unavailable', 'remote support is not configured on this server');
  }

  private base(actor: Actor, hubId: string, envelopeId: string, ttlMs: number) {
    const now = this.now();
    return { v: ENVELOPE_VERSION, envelopeId, hubId, issuedAt: now, expiresAt: now + ttlMs, actor } as const;
  }

  private async send(hubId: string, envelope: CloudEnvelope): Promise<void> {
    await this.transport!.publish(hubId, this.signer!.sign(envelope));
  }

  private ask<T>(requestId: string, envelopeId: string, sendIt: () => Promise<void>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.pending.delete(requestId);
        this.envelopeToRequest.delete(envelopeId);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new CloudError(504, 'hub_timeout', 'the hub did not answer in time'));
      }, this.resultTimeoutMs);
      this.pending.set(requestId, {
        resolve: (v) => {
          cleanup();
          resolve(v as T);
        },
        reject: (e) => {
          cleanup();
          reject(e);
        },
        timer,
      });
      this.envelopeToRequest.set(envelopeId, requestId);
      sendIt().catch((e: Error) => this.pending.get(requestId)?.reject(e));
    });
  }

  private async settle(hubId: string, requestId: string, grantId: string, value: unknown): Promise<void> {
    const p = this.pending.get(requestId);
    if (!p) return;
    const [g] = await this.db.query('SELECT 1 FROM grants WHERE grant_id = $1 AND hub_id = $2', [grantId, hubId]);
    if (g) p.resolve(value);
  }

  private async row(homeId: string, grantId: string): Promise<GrantRow> {
    const [g] = await this.db.query<GrantRow>(`${GRANT_SELECT} WHERE g.grant_id = $1 AND g.home_id = $2`, [grantId, homeId]);
    if (!g) throw notFound();
    return g;
  }

  private async notice(grantId: string) {
    const [r] = await this.db.query<GrantRow & { home_name: string; owner_contact: string | null }>(
      `SELECT g.*, s.display_name, h.name AS home_name, h.owner_contact FROM grants g JOIN staff s ON s.id = g.staff_id JOIN homes h ON h.id = g.home_id WHERE g.grant_id = $1`,
      [grantId],
    );
    return {
      grantId,
      homeId: r!.home_id,
      homeName: r!.home_name,
      staffName: r!.display_name,
      actions: JSON.parse(r!.actions) as string[],
      deviceIds: JSON.parse(r!.device_ids) as string[],
      endsAt: Number(r!.ends_at),
      ownerContact: r!.owner_contact,
    };
  }

  private async view(r: GrantRow): Promise<CloudGrantView> {
    return {
      grantId: r.grant_id,
      homeId: r.home_id,
      hubId: r.hub_id,
      staff: { staffId: r.staff_id, role: r.staff_role, displayName: r.display_name },
      deviceIds: JSON.parse(r.device_ids) as string[],
      actions: JSON.parse(r.actions) as GrantAction[],
      reason: r.reason,
      ticketRef: r.ticket_ref,
      startsAt: Number(r.starts_at),
      endsAt: Number(r.ends_at),
      status: r.status,
      requestedAt: Number(r.requested_at),
      startNoticeAt: r.start_notice_at === null ? null : Number(r.start_notice_at),
      ownerNotified: r.start_notice_at !== null && (await this.notifications.startNoticeDelivered(r.grant_id)),
      endedAt: r.ended_at === null ? null : Number(r.ended_at),
      endReason: r.end_reason,
    };
  }
}

export function actorOf(staff: { id: string; role: PlatformRole; display_name: string }): Actor {
  return { staffId: staff.id, role: staff.role, displayName: staff.display_name };
}
