import { createHash, randomUUID } from 'node:crypto';
import type { HubAuditRecord } from '@voltax/contracts';
import type { DB } from './db.js';

export const GENESIS_HASH = '0'.repeat(64);

export type AuditOutcome = HubAuditRecord['outcome'];

export interface AuditInput {
  actor: string; // 'client:<id>', 'cloud:<staffId>', 'installer-cli', 'hub', 'ip:<addr>'
  action: string;
  outcome: AuditOutcome;
  target?: string | null;
  details?: Record<string, unknown>;
}

interface AuditRow {
  seq: number;
  id: string;
  at: number;
  actor: string;
  action: string;
  outcome: AuditOutcome;
  target: string | null;
  details: string;
  prev_hash: string;
  hash: string;
}

// Keys whose values must never be stored, at any depth. Values are dropped, the key is kept as a marker.
const SECRET_KEY = /token|password|passwd|secret|pairing_?code|^code$|authorization|cookie|private|api_?key|signature|^sig$/i;
const MAX_STRING = 200;

/** Removes secrets and bounds size, so an audit record can never leak credentials or bulk data. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]';
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    return out;
  }
  return value;
}

export function auditHash(prevHash: string, r: Omit<HubAuditRecord, 'seq' | 'prevHash' | 'hash'>): string {
  const canonical = JSON.stringify([r.id, r.at, r.actor, r.action, r.outcome, r.target, r.details]);
  return createHash('sha256').update(prevHash).update('\n').update(canonical).digest('hex');
}

/**
 * Append-only security audit log. SQLite triggers refuse UPDATE/DELETE; each record is chained to the
 * previous one by hash so silent edits are detectable by verify(). A hash chain alone does not stop
 * someone with root on the hub from rewriting everything: the off-device copy (cloud export) is what
 * makes that detectable. See docs/security/audit-threat-model.md.
 */
export class AuditLog {
  private listeners = new Set<(r: HubAuditRecord) => void>();

  constructor(private db: DB) {}

  append(input: AuditInput): HubAuditRecord {
    const record = this.db.transaction(() => {
      const last = this.db.prepare('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1').get() as { hash: string } | undefined;
      const prevHash = last?.hash ?? this.anchor();
      const base = {
        id: randomUUID(),
        at: Date.now(),
        actor: input.actor.slice(0, 128),
        action: input.action.slice(0, 64),
        outcome: input.outcome,
        target: input.target?.slice(0, 256) ?? null,
        details: redact(input.details ?? {}) as Record<string, unknown>,
      };
      const hash = auditHash(prevHash, base);
      const res = this.db
        .prepare(
          'INSERT INTO audit_log (id, at, actor, action, outcome, target, details, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(base.id, base.at, base.actor, base.action, base.outcome, base.target, JSON.stringify(base.details), prevHash, hash);
      return { seq: Number(res.lastInsertRowid), ...base, prevHash, hash };
    })();
    for (const l of this.listeners) l(record);
    return record;
  }

  since(afterSeq: number, limit = 500): HubAuditRecord[] {
    return (this.db.prepare('SELECT * FROM audit_log WHERE seq > ? ORDER BY seq LIMIT ?').all(afterSeq, limit) as AuditRow[]).map(toRecord);
  }

  /** Recomputes the whole chain. Returns the first broken seq, if any. */
  verify(): { ok: true; count: number } | { ok: false; brokenAt: number; reason: string } {
    let prev = this.anchor();
    let count = 0;
    for (const row of this.db.prepare('SELECT * FROM audit_log ORDER BY seq').iterate() as Iterable<AuditRow>) {
      const r = toRecord(row);
      if (r.prevHash !== prev) return { ok: false, brokenAt: r.seq, reason: 'previous hash does not match' };
      if (auditHash(prev, r) !== r.hash) return { ok: false, brokenAt: r.seq, reason: 'record hash does not match its content' };
      prev = r.hash;
      count++;
    }
    return { ok: true, count };
  }

  onAppend(listener: (r: HubAuditRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Hash the chain starts from: genesis, or the last archived record's hash after controlled archival. */
  private anchor(): string {
    const row = this.db.prepare("SELECT value FROM hub_meta WHERE key = 'audit_anchor'").get() as { value: string } | undefined;
    return row?.value ?? GENESIS_HASH;
  }
}

function toRecord(r: AuditRow): HubAuditRecord {
  return {
    seq: r.seq,
    id: r.id,
    at: r.at,
    actor: r.actor,
    action: r.action,
    outcome: r.outcome,
    target: r.target,
    details: JSON.parse(r.details) as Record<string, unknown>,
    prevHash: r.prev_hash,
    hash: r.hash,
  };
}
