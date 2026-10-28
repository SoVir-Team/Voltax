import { parseEntityId, type CommandStatus, type CommandView, type EntityRef } from '@voltax/contracts';
import type { DB } from './db.js';
import type { EventLog } from './events.js';
import type { StateReport } from './mqtt-link.js';
import type { Store } from './store.js';

export interface CommandTransport {
  readonly connected: boolean;
  publishCommand(ref: EntityRef, value: boolean): Promise<void>;
  onState(listener: (report: StateReport) => void): () => void;
}

export interface SubmitInput {
  commandId: string;
  entityId: string;
  value: boolean;
  source: CommandView['source'];
  ttlMs?: number;
  expiresAt?: number;
  /** Cloud commands: the support grant that authorised it (re-checked right before dispatch). */
  grantId?: string;
}

/** Returns a refusal reason, or null to let the command go out. Must be synchronous. */
export type PreDispatchCheck = (command: CommandView) => string | null;

export type SubmitResult =
  | { status: 200 | 202 | 410; command: CommandView }
  | { status: 404 | 409 | 422; error: string };

interface CommandRow {
  command_id: string;
  entity_id: string;
  value: number;
  source: CommandView['source'];
  status: CommandStatus;
  reason: string | null;
  issued_at: number;
  expires_at: number;
  grant_id: string | null;
}

interface Waiter {
  value: boolean;
  resolve: () => void;
}

export const DEFAULT_TTL_MS = 10_000;

/**
 * Single entry point for every command (local API, schedules, automations, later the cloud).
 * - commandId is idempotent: a repeat returns the original result, never re-executes.
 * - Past-deadline commands are rejected (410) and never published.
 * - One in-flight command per entity, so a state report can be matched to its command.
 * - "confirmed" only after the device REPORTS the requested state; MQTT delivery is not success.
 */
export class CommandManager {
  private queues = new Map<string, string[]>();
  private busy = new Set<string>();
  private waiters = new Map<string, Waiter>();
  private idle: Array<() => void> = [];
  private stopped = false;
  private preDispatch: PreDispatchCheck = () => null;
  private onStop!: () => void;
  private stopSignal = new Promise<'stopped'>((resolve) => (this.onStop = () => resolve('stopped')));

  constructor(
    private db: DB,
    private store: Store,
    private events: EventLog,
    private transport: CommandTransport,
    private defaultTtlMs = DEFAULT_TTL_MS,
  ) {
    transport.onState((r) => {
      const waiter = this.waiters.get(r.entityId);
      // Retained snapshots are old news, not a reaction to our command.
      if (waiter && !r.retained && r.value === waiter.value) waiter.resolve();
    });
  }

  setPreDispatch(check: PreDispatchCheck): void {
    this.preDispatch = check;
  }

  /** Cancels commands still waiting in a queue (never published). Returns the cancelled ids. */
  cancelQueued(match: (command: CommandView) => boolean, reason: string): string[] {
    const cancelled: string[] = [];
    for (const [entityId, queue] of this.queues) {
      const keep: string[] = [];
      for (const id of queue) {
        const cmd = this.get(id);
        if (cmd && cmd.status === 'pending' && match(cmd)) {
          this.finish(cmd, 'failed', reason);
          cancelled.push(id);
        } else keep.push(id);
      }
      this.queues.set(entityId, keep);
    }
    return cancelled;
  }

  /** Commands of a grant that were already published and are waiting for the device's report. */
  inFlightForGrant(grantId: string): CommandView[] {
    return (this.db.prepare("SELECT * FROM commands WHERE grant_id = ? AND status = 'sent'").all(grantId) as CommandRow[]).map(toView);
  }

  /** Commands that were in flight when the hub stopped are failed, never replayed. */
  recoverAfterRestart(): number {
    return this.db
      .prepare("UPDATE commands SET status = 'failed', reason = 'hub restarted', done_at = ? WHERE status IN ('pending', 'sent')")
      .run(Date.now()).changes;
  }

  submit(input: SubmitInput): SubmitResult {
    const existing = this.get(input.commandId);
    if (existing) {
      if (existing.entityId !== input.entityId || existing.value !== input.value) {
        return { status: 409, error: 'commandId already used for a different command' };
      }
      return { status: existing.status === 'expired' ? 410 : 200, command: existing };
    }

    const ref = parseEntityId(input.entityId);
    const entity = ref && this.store.getEntity(input.entityId);
    if (!ref || !entity) return { status: 404, error: 'unknown entity' };
    if (entity.component !== 'switch') return { status: 422, error: 'entity is not controllable' };

    const now = Date.now();
    const expiresAt = Math.min(input.expiresAt ?? Number.POSITIVE_INFINITY, now + (input.ttlMs ?? this.defaultTtlMs));
    const expired = expiresAt <= now;
    this.db
      .prepare(
        `INSERT INTO commands (command_id, entity_id, value, source, status, reason, issued_at, expires_at, done_at, grant_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.commandId,
        input.entityId,
        input.value ? 1 : 0,
        input.source,
        expired ? 'expired' : 'pending',
        expired ? 'deadline passed before execution' : null,
        now,
        expiresAt,
        expired ? now : null,
        input.grantId ?? null,
      );
    const command = this.get(input.commandId)!;
    this.emit(command);
    if (expired) return { status: 410, command };

    const queue = this.queues.get(input.entityId) ?? [];
    queue.push(input.commandId);
    this.queues.set(input.entityId, queue);
    void this.pump(input.entityId);
    return { status: 202, command };
  }

  get(commandId: string): CommandView | null {
    const row = this.db.prepare('SELECT * FROM commands WHERE command_id = ?').get(commandId) as CommandRow | undefined;
    return row ? toView(row) : null;
  }

  /** Resolves when no command is queued or in flight (used by tests and shutdown). */
  async drain(): Promise<void> {
    if (this.busy.size === 0) return;
    await new Promise<void>((resolve) => this.idle.push(resolve));
  }

  /**
   * Hub shutdown: stop touching the database. Commands still in flight are left as pending/sent and
   * marked failed by recoverAfterRestart() on the next start (never replayed).
   */
  stop(): void {
    this.stopped = true;
    this.onStop();
    for (const done of this.idle.splice(0)) done();
  }

  prune(olderThanMs = 24 * 60 * 60 * 1000): number {
    return this.db
      .prepare("DELETE FROM commands WHERE issued_at < ? AND status NOT IN ('pending', 'sent')")
      .run(Date.now() - olderThanMs).changes;
  }

  private async pump(entityId: string): Promise<void> {
    if (this.stopped || this.busy.has(entityId)) return;
    const queue = this.queues.get(entityId);
    const next = queue?.shift();
    if (!next) {
      this.queues.delete(entityId);
      if (this.busy.size === 0) for (const done of this.idle.splice(0)) done();
      return;
    }
    this.busy.add(entityId);
    try {
      await this.run(next);
    } finally {
      this.busy.delete(entityId);
      void this.pump(entityId);
    }
  }

  private async run(commandId: string): Promise<void> {
    const cmd = this.get(commandId)!;
    const ref = parseEntityId(cmd.entityId)!;
    if (Date.now() >= cmd.expiresAt) return this.finish(cmd, 'expired', 'deadline passed while queued');
    if (!this.transport.connected) return this.finish(cmd, 'failed', 'hub not connected to broker');
    if (!this.store.isDeviceOnline(ref.deviceId)) return this.finish(cmd, 'failed', 'device offline');
    // Last authorisation check, immediately before the publish below (no await in between).
    const refusal = this.preDispatch(cmd);
    if (refusal) return this.finish(cmd, 'failed', refusal);

    let confirm!: () => void;
    const confirmed = new Promise<void>((resolve) => (confirm = resolve));
    this.waiters.set(cmd.entityId, { value: cmd.value, resolve: confirm });
    let timer: NodeJS.Timeout | undefined;
    try {
      try {
        await this.transport.publishCommand(ref, cmd.value);
      } catch (err) {
        return this.finish(cmd, 'failed', `publish failed: ${(err as Error).message}`);
      }
      if (this.stopped) return;
      this.db.prepare("UPDATE commands SET status = 'sent', sent_at = ? WHERE command_id = ?").run(Date.now(), commandId);
      this.emit(this.get(commandId)!);

      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), Math.max(0, cmd.expiresAt - Date.now()));
      });
      const outcome = await Promise.race([confirmed.then(() => 'confirmed' as const), timedOut, this.stopSignal]);
      if (outcome === 'stopped') return;
      if (outcome === 'confirmed') return this.finish(cmd, 'confirmed', null);

      // No fresh report, but the device already reports the requested state (e.g. ON while ON).
      const entity = this.store.getEntity(cmd.entityId);
      if (entity?.state === cmd.value && this.store.isDeviceOnline(ref.deviceId)) {
        return this.finish(cmd, 'confirmed', 'device already reported the requested state');
      }
      return this.finish(cmd, 'failed', 'no state confirmation before deadline');
    } finally {
      clearTimeout(timer);
      this.waiters.delete(cmd.entityId);
    }
  }

  private finish(cmd: CommandView, status: CommandStatus, reason: string | null): void {
    if (this.stopped) return;
    this.db
      .prepare('UPDATE commands SET status = ?, reason = ?, done_at = ? WHERE command_id = ?')
      .run(status, reason, Date.now(), cmd.commandId);
    this.emit(this.get(cmd.commandId)!);
  }

  private emit(command: CommandView): void {
    this.events.append('command.status', { ...command });
  }
}

function toView(r: CommandRow): CommandView {
  return {
    commandId: r.command_id,
    entityId: r.entity_id,
    value: r.value === 1,
    source: r.source,
    status: r.status,
    issuedAt: r.issued_at,
    expiresAt: r.expires_at,
    ...(r.reason ? { reason: r.reason } : {}),
    ...(r.grant_id ? { grantId: r.grant_id } : {}),
  };
}
