import { randomUUID } from 'node:crypto';
import type { AutomationInput } from '@voltax/contracts';
import type { CommandManager } from './commands.js';
import type { DB } from './db.js';
import type { EventLog } from './events.js';
import type { StateReport } from './mqtt-link.js';
import { switchTargetError } from './scheduler.js';

export class InvalidAutomationError extends Error {}

export interface Automation extends AutomationInput {
  automationId: string;
  version: number;
  updatedAt: number;
}

interface AutomationRow {
  automation_id: string;
  name: string;
  enabled: number;
  definition: string;
  version: number;
  updated_at: number;
}

/**
 * Local trigger -> action rules. Only LIVE state transitions trigger: retained snapshots
 * (replayed after a reconnect) and duplicate reports never do.
 * Pending "revert after N seconds" timers live in memory and are dropped on hub restart.
 */
export class AutomationEngine {
  private revertTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private db: DB,
    private commands: CommandManager,
    private events: EventLog,
  ) {}

  handleState(report: StateReport): void {
    if (report.retained || !report.changed) return;
    for (const a of this.list()) {
      if (!a.enabled || a.trigger.entityId !== report.entityId || a.trigger.to !== report.value) continue;
      this.run(a);
    }
  }

  stop(): void {
    for (const t of this.revertTimers.values()) clearTimeout(t);
    this.revertTimers.clear();
  }

  list(): Automation[] {
    return (this.db.prepare('SELECT * FROM automations ORDER BY name').all() as AutomationRow[]).map(toAutomation);
  }

  get(id: string): Automation | null {
    const row = this.db.prepare('SELECT * FROM automations WHERE automation_id = ?').get(id) as AutomationRow | undefined;
    return row ? toAutomation(row) : null;
  }

  create(input: AutomationInput): Automation {
    this.validate(input);
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO automations (automation_id, name, enabled, definition, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, input.name, input.enabled ? 1 : 0, definition(input), Date.now());
    return this.get(id)!;
  }

  /** null = not found; 'conflict' = `version` is not the stored one. Any accepted edit cancels a pending revert. */
  update(id: string, input: AutomationInput, version: number): Automation | null | 'conflict' {
    this.validate(input);
    const changes = this.db
      .prepare('UPDATE automations SET name = ?, enabled = ?, definition = ?, version = version + 1, updated_at = ? WHERE automation_id = ? AND version = ?')
      .run(input.name, input.enabled ? 1 : 0, definition(input), Date.now(), id, version).changes;
    if (!changes) return this.get(id) ? 'conflict' : null;
    this.clearTimer(id);
    return this.get(id);
  }

  delete(id: string): boolean {
    this.clearTimer(id);
    return this.db.prepare('DELETE FROM automations WHERE automation_id = ?').run(id).changes > 0;
  }

  private validate(input: AutomationInput): void {
    if (!this.db.prepare('SELECT 1 FROM entities WHERE entity_id = ?').get(input.trigger.entityId)) {
      throw new InvalidAutomationError(`unknown entity ${input.trigger.entityId}`);
    }
    const target = switchTargetError(this.db, input.action.entityId);
    if (target) throw new InvalidAutomationError(target);
  }

  private run(a: Automation): void {
    const { entityId, value, revertAfterSeconds } = a.action;
    const commandId = randomUUID();
    this.events.append('automation.fired', { automationId: a.automationId, entityId, value, commandId });
    this.commands.submit({ commandId, entityId, value, source: 'automation' });

    if (revertAfterSeconds) {
      // Re-triggering restarts the countdown instead of stacking timers.
      this.clearTimer(a.automationId);
      const timer = setTimeout(() => {
        this.revertTimers.delete(a.automationId);
        this.commands.submit({ commandId: randomUUID(), entityId, value: !value, source: 'automation' });
      }, revertAfterSeconds * 1000);
      this.revertTimers.set(a.automationId, timer);
    }
  }

  private clearTimer(id: string): void {
    clearTimeout(this.revertTimers.get(id));
    this.revertTimers.delete(id);
  }
}

function definition(input: AutomationInput): string {
  return JSON.stringify({ trigger: input.trigger, action: input.action });
}

function toAutomation(r: AutomationRow): Automation {
  const def = JSON.parse(r.definition) as Pick<AutomationInput, 'trigger' | 'action'>;
  return { automationId: r.automation_id, name: r.name, enabled: r.enabled === 1, ...def, version: r.version, updatedAt: r.updated_at };
}
