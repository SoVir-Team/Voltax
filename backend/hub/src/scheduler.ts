import { randomUUID } from 'node:crypto';
import { Cron } from 'croner';
import type { ScheduleInput } from '@voltax/contracts';
import type { CommandManager } from './commands.js';
import type { DB } from './db.js';
import type { EventLog } from './events.js';

export interface Schedule extends ScheduleInput {
  scheduleId: string;
  version: number;
  updatedAt: number;
}

interface ScheduleRow {
  schedule_id: string;
  name: string;
  cron: string;
  entity_id: string;
  value: number;
  enabled: number;
  version: number;
  updated_at: number;
}

export class InvalidScheduleError extends Error {}

/** The rule's target must exist and be a switch (sensors cannot be commanded). Shared with automations. */
export function switchTargetError(db: DB, entityId: string): string | null {
  const row = db.prepare('SELECT component FROM entities WHERE entity_id = ?').get(entityId) as { component: string } | undefined;
  if (!row) return `unknown entity ${entityId}`;
  return row.component === 'switch' ? null : `${entityId} is not a switch`;
}

/**
 * Runs schedules on the hub itself (no cloud). Missed runs while the hub is off are NOT replayed:
 * croner only fires future occurrences.
 */
export class Scheduler {
  private jobs = new Map<string, Cron>();

  constructor(
    private db: DB,
    private commands: CommandManager,
    private events: EventLog,
    private timezone: string,
  ) {}

  start(): void {
    for (const s of this.list()) this.arm(s);
  }

  stop(): void {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
  }

  list(): Schedule[] {
    return (this.db.prepare('SELECT * FROM schedules ORDER BY name').all() as ScheduleRow[]).map(toSchedule);
  }

  get(id: string): Schedule | null {
    const row = this.db.prepare('SELECT * FROM schedules WHERE schedule_id = ?').get(id) as ScheduleRow | undefined;
    return row ? toSchedule(row) : null;
  }

  create(input: ScheduleInput): Schedule {
    this.validate(input);
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO schedules (schedule_id, name, cron, entity_id, value, enabled, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.name, input.cron, input.entityId, input.value ? 1 : 0, input.enabled ? 1 : 0, Date.now());
    const s = this.get(id)!;
    this.arm(s);
    return s;
  }

  /** null = not found; 'conflict' = `version` is not the stored one (someone else saved first). */
  update(id: string, input: ScheduleInput, version: number): Schedule | null | 'conflict' {
    this.validate(input);
    const changes = this.db
      .prepare(
        'UPDATE schedules SET name = ?, cron = ?, entity_id = ?, value = ?, enabled = ?, version = version + 1, updated_at = ? WHERE schedule_id = ? AND version = ?',
      )
      .run(input.name, input.cron, input.entityId, input.value ? 1 : 0, input.enabled ? 1 : 0, Date.now(), id, version).changes;
    if (!changes) return this.get(id) ? 'conflict' : null;
    const s = this.get(id)!;
    this.arm(s);
    return s;
  }

  delete(id: string): boolean {
    this.jobs.get(id)?.stop();
    this.jobs.delete(id);
    return this.db.prepare('DELETE FROM schedules WHERE schedule_id = ?').run(id).changes > 0;
  }

  nextRun(id: string): Date | null {
    return this.jobs.get(id)?.nextRun() ?? null;
  }

  private arm(s: Schedule): void {
    this.jobs.get(s.scheduleId)?.stop();
    this.jobs.delete(s.scheduleId);
    if (!s.enabled) return;
    const job = new Cron(s.cron, { timezone: this.timezone, protect: true }, () => this.fire(s.scheduleId));
    this.jobs.set(s.scheduleId, job);
  }

  private fire(id: string): void {
    const s = this.get(id);
    if (!s || !s.enabled) return;
    const commandId = randomUUID();
    this.events.append('schedule.fired', { scheduleId: id, entityId: s.entityId, value: s.value, commandId });
    this.commands.submit({ commandId, entityId: s.entityId, value: s.value, source: 'schedule' });
  }

  private validate(input: ScheduleInput): void {
    const target = switchTargetError(this.db, input.entityId);
    if (target) throw new InvalidScheduleError(target);
    try {
      new Cron(input.cron, { paused: true, timezone: this.timezone }).stop();
    } catch (err) {
      throw new InvalidScheduleError(`invalid cron expression: ${(err as Error).message}`);
    }
  }
}

function toSchedule(r: ScheduleRow): Schedule {
  return {
    scheduleId: r.schedule_id,
    name: r.name,
    cron: r.cron,
    entityId: r.entity_id,
    value: r.value === 1,
    enabled: r.enabled === 1,
    version: r.version,
    updatedAt: r.updated_at,
  };
}
