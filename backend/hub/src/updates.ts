import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  compareVersions,
  platformScope,
  updateStateSchema,
  VERSION_PATTERN,
  type CloudEnvelope,
  type HubMessage,
  type HubUpdatesView,
  type UpdateOfferStatus,
  type UpdateOfferView,
  type UpdatePolicy,
  type UpdateState,
} from '@voltax/contracts';
import type { AuditLog } from './audit.js';
import type { DB } from './db.js';
import type { EventLog } from './events.js';

const resultSchema = z.object({
  version: z.string().max(32),
  state: updateStateSchema,
  at: z.number().int().optional(),
  message: z.string().max(500).optional(),
  rolloutId: z.string().max(64).optional(),
});

export type UpdateResult = z.infer<typeof resultSchema>;

/**
 * Hand-off between the unprivileged hub and the root updater on the Pi host.
 * The hub can only drop a request ({version}) into a folder. A root systemd path unit picks it up
 * and runs voltax-update, which verifies the minisign signature itself and refuses downgrades,
 * so a compromised hub process cannot install anything that VOLTEX did not sign.
 */
export class UpdateDropbox {
  constructor(private dir: string) {}

  request(version: string, rolloutId?: string): void {
    if (!/^\d+\.\d+\.\d+(-[0-9a-z.]+)?$/i.test(version)) throw new Error('invalid version');
    mkdirSync(this.dir, { recursive: true });
    const tmp = join(this.dir, '.request.json.tmp');
    writeFileSync(tmp, JSON.stringify({ version, ...(rolloutId ? { rolloutId } : {}), at: Date.now() }));
    renameSync(tmp, join(this.dir, 'request.json')); // atomic: the path unit never sees half a file
  }

  pending(): boolean {
    return existsSync(join(this.dir, 'request.json'));
  }

  result(): UpdateResult | null {
    const file = join(this.dir, 'result.json');
    if (!existsSync(file)) return null;
    try {
      const parsed = resultSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  state(): { state: UpdateState; version?: string } {
    if (this.pending()) return { state: 'requested' };
    const r = this.result();
    return r ? { state: r.state, version: r.version } : { state: 'idle' };
  }
}

interface OfferRow {
  rollout_id: string;
  version: string;
  offered_at: number;
  offered_by: string;
  status: UpdateOfferStatus;
  decided_at: number | null;
  decided_by: string | null;
}

export type OfferDecision = 'ok' | 'not_found' | 'already_decided' | 'busy';

/**
 * Fleet updates on the hub. The cloud can only OFFER a version, in an envelope signed for a super
 * admin; the owner's local policy decides (default: the owner approves each one). An approved offer
 * becomes a request for the root updater, which checks the release signature itself.
 */
export class UpdateService {
  private send: (msg: HubMessage) => void = () => {};
  private timer: NodeJS.Timeout | undefined;

  constructor(private deps: { db: DB; audit: AuditLog; events: EventLog; dropbox: UpdateDropbox; currentVersion: string; now?: () => number }) {}

  setSink(send: (msg: HubMessage) => void): void {
    this.send = send;
  }

  start(intervalMs = 5_000): void {
    this.poll();
    this.timer = setInterval(() => this.poll(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  policy(): UpdatePolicy {
    const row = this.deps.db.prepare("SELECT value FROM hub_meta WHERE key = 'update_policy'").get() as { value: string } | undefined;
    return row?.value === 'auto' ? 'auto' : 'approve';
  }

  setPolicy(policy: UpdatePolicy, actor: string): void {
    this.setMeta('update_policy', policy);
    this.deps.audit.append({ actor, action: 'update.policy', outcome: 'ok', details: { policy } });
  }

  view(): HubUpdatesView {
    const rows = this.deps.db.prepare('SELECT * FROM update_offers ORDER BY offered_at DESC LIMIT 50').all() as OfferRow[];
    return { policy: this.policy(), currentVersion: this.deps.currentVersion, state: this.deps.dropbox.state(), offers: rows.map(toOfferView) };
  }

  /** A verified `hub.update` envelope. Returns a refusal reason, or null when accepted. */
  offer(env: Extract<CloudEnvelope, { type: 'hub.update' }>): string | null {
    if (platformScope(env.actor.role, 'hub.update') !== 'platform') return 'role may not offer hub updates';
    if (!VERSION_PATTERN.test(this.deps.currentVersion)) return 'this hub is not running a release version';
    if (compareVersions(env.version, this.deps.currentVersion) <= 0) return 'not newer than the installed version';
    const existing = this.row(env.rolloutId);
    if (existing) {
      if (existing.version !== env.version) return 'rollout already offered a different version';
      this.report(existing); // the cloud asks again (it may have missed our answer): repeat it
      return null;
    }
    this.deps.db
      .prepare("INSERT INTO update_offers (rollout_id, version, offered_at, offered_by, status) VALUES (?, ?, ?, ?, 'pending')")
      .run(env.rolloutId, env.version, this.now(), env.actor.displayName);
    this.deps.audit.append({ actor: `cloud:${env.actor.staffId}`, action: 'update.offer', outcome: 'ok', target: env.rolloutId, details: { version: env.version } });
    this.deps.events.append('update.offered', { rolloutId: env.rolloutId, version: env.version, offeredBy: env.actor.displayName });
    if (this.policy() === 'auto' && !this.deps.dropbox.pending()) this.decide(env.rolloutId, 'approved', 'policy:auto', 'hub');
    else this.report(this.row(env.rolloutId)!);
    return null;
  }

  /** A verified `hub.update.withdraw` envelope: takes back an offer the owner has not decided. */
  withdraw(env: Extract<CloudEnvelope, { type: 'hub.update.withdraw' }>): string | null {
    if (platformScope(env.actor.role, 'hub.update') !== 'platform') return 'role may not withdraw hub updates';
    const row = this.row(env.rolloutId);
    if (!row) return 'unknown rollout';
    if (row.status === 'pending') {
      this.deps.db.prepare("UPDATE update_offers SET status = 'withdrawn', decided_at = ?, decided_by = 'cloud' WHERE rollout_id = ?").run(this.now(), env.rolloutId);
      this.deps.audit.append({ actor: `cloud:${env.actor.staffId}`, action: 'update.withdraw', outcome: 'ok', target: env.rolloutId });
      this.deps.events.append('update.decided', { rolloutId: env.rolloutId, version: row.version, status: 'withdrawn' });
    }
    this.report(this.row(env.rolloutId)!);
    return null;
  }

  approve(rolloutId: string, clientId: string): OfferDecision {
    return this.ownerDecision(rolloutId, 'approved', clientId);
  }

  decline(rolloutId: string, clientId: string): OfferDecision {
    return this.ownerDecision(rolloutId, 'declined', clientId);
  }

  /** Reports the root updater's result once per rollout and state (survives hub restarts). */
  poll(): void {
    if (this.deps.dropbox.pending()) return;
    const result = this.deps.dropbox.result();
    if (!result?.rolloutId) return;
    const key = `${result.rolloutId}:${result.state}`;
    const last = this.deps.db.prepare("SELECT value FROM hub_meta WHERE key = 'update_reported'").get() as { value: string } | undefined;
    if (last?.value === key) return;
    this.setMeta('update_reported', key);
    this.deps.audit.append({ actor: 'hub', action: 'update.result', outcome: result.state === 'done' ? 'ok' : 'error', target: result.rolloutId, details: { version: result.version, state: result.state } });
    this.deps.events.append('update.result', { rolloutId: result.rolloutId, version: result.version, state: result.state });
    this.send({ type: 'update.status', rolloutId: result.rolloutId, state: result.state, version: result.version });
  }

  private ownerDecision(rolloutId: string, status: 'approved' | 'declined', clientId: string): OfferDecision {
    const row = this.row(rolloutId);
    if (!row) return 'not_found';
    if (row.status !== 'pending') return 'already_decided';
    if (status === 'approved' && this.deps.dropbox.pending()) return 'busy';
    this.decide(rolloutId, status, clientId, `client:${clientId}`);
    return 'ok';
  }

  private decide(rolloutId: string, status: 'approved' | 'declined', decidedBy: string, actor: string): void {
    const row = this.row(rolloutId)!;
    if (status === 'approved') this.deps.dropbox.request(row.version, rolloutId);
    this.deps.db.prepare('UPDATE update_offers SET status = ?, decided_at = ?, decided_by = ? WHERE rollout_id = ?').run(status, this.now(), decidedBy, rolloutId);
    this.deps.audit.append({ actor, action: status === 'approved' ? 'update.approve' : 'update.decline', outcome: 'ok', target: rolloutId, details: { version: row.version } });
    this.deps.events.append('update.decided', { rolloutId, version: row.version, status });
    this.report(this.row(rolloutId)!);
  }

  private report(row: OfferRow): void {
    const state: UpdateState =
      row.status === 'pending' ? 'awaiting_approval' : row.status === 'declined' ? 'declined' : row.status === 'withdrawn' ? 'withdrawn' : this.approvedState(row);
    this.send({ type: 'update.status', rolloutId: row.rollout_id, state, version: row.version });
  }

  /** After approval: what the root updater says, if it is about this rollout. */
  private approvedState(row: OfferRow): UpdateState {
    if (this.deps.dropbox.pending()) return 'requested';
    const result = this.deps.dropbox.result();
    return result?.rolloutId === row.rollout_id ? result.state : 'requested';
  }

  private row(rolloutId: string): OfferRow | undefined {
    return this.deps.db.prepare('SELECT * FROM update_offers WHERE rollout_id = ?').get(rolloutId) as OfferRow | undefined;
  }

  private setMeta(key: string, value: string): void {
    this.deps.db.prepare('INSERT INTO hub_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
}

function toOfferView(r: OfferRow): UpdateOfferView {
  return { rolloutId: r.rollout_id, version: r.version, offeredAt: r.offered_at, offeredBy: r.offered_by, status: r.status, decidedAt: r.decided_at, decidedBy: r.decided_by };
}
