import { createHash, randomUUID } from 'node:crypto';
import type { Db } from './db.js';

export const GENESIS_HASH = '0'.repeat(64);
// Serialises appends across all cloud processes so the chain never forks.
const AUDIT_LOCK_KEY = 0x766f6c74; // 'volt'

export type AuditOutcome = 'allowed' | 'denied' | 'ok' | 'error';

export interface AuditInput {
  actor: string; // 'staff:<id>', 'hub:<hubId>', 'system', 'ip:<addr>', 'cli'
  action: string;
  outcome: AuditOutcome;
  target?: string | null;
  homeId?: string | null;
  details?: Record<string, unknown>;
}

export interface AuditRecord {
  seq: number;
  id: string;
  at: number;
  actor: string;
  action: string;
  outcome: AuditOutcome;
  target: string | null;
  homeId: string | null;
  details: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

interface Row {
  seq: number;
  id: string;
  at: number;
  actor: string;
  action: string;
  outcome: AuditOutcome;
  target: string | null;
  home_id: string | null;
  details: string;
  prev_hash: string;
  hash: string;
}

// Keys whose values are never stored, at any depth (same rule as the hub).
const SECRET_KEY = /token|password|passwd|secret|totp|^code$|otp|authorization|cookie|private|api_?key|signature|^sig$|session/i;
const MAX_STRING = 200;

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

export function auditHash(prevHash: string, r: { id: string; at: number; actor: string; action: string; outcome: string; target: string | null; homeId: string | null }, detailsJson: string): string {
  const canonical = JSON.stringify([r.id, r.at, r.actor, r.action, r.outcome, r.target, r.homeId, detailsJson]);
  return createHash('sha256').update(prevHash).update('\n').update(canonical).digest('hex');
}

/**
 * Append-only, hash-chained audit log. Postgres triggers refuse UPDATE/DELETE/TRUNCATE; the
 * production app role only has INSERT/SELECT on it. Periodic signed checkpoints and the external
 * copy are what detect a privileged rewrite (docs/security/audit-threat-model.md).
 */
export class CloudAudit {
  private listeners = new Set<(r: AuditRecord) => void>();

  constructor(private db: Db) {}

  async append(input: AuditInput): Promise<AuditRecord> {
    const record = await this.db.tx(async (t) => {
      await t.query('SELECT pg_advisory_xact_lock($1)', [AUDIT_LOCK_KEY]);
      const [last] = await t.query<{ hash: string }>('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1');
      const prevHash = last?.hash ?? (await this.anchor(t));
      const base = {
        id: randomUUID(),
        at: Date.now(),
        actor: input.actor.slice(0, 128),
        action: input.action.slice(0, 64),
        outcome: input.outcome,
        target: input.target?.slice(0, 256) ?? null,
        homeId: input.homeId ?? null,
      };
      const details = redact(input.details ?? {}) as Record<string, unknown>;
      const detailsJson = JSON.stringify(details);
      const hash = auditHash(prevHash, base, detailsJson);
      const [row] = await t.query<{ seq: number }>(
        `INSERT INTO audit_log (id, at, actor, action, outcome, target, home_id, details, prev_hash, hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING seq`,
        [base.id, base.at, base.actor, base.action, base.outcome, base.target, base.homeId, detailsJson, prevHash, hash],
      );
      return { seq: Number(row!.seq), ...base, details, prevHash, hash } satisfies AuditRecord;
    });
    for (const l of this.listeners) l(record);
    return record;
  }

  async list(opts: { afterSeq?: number; homeId?: string; limit?: number } = {}): Promise<AuditRecord[]> {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const rows = opts.homeId
      ? await this.db.query<Row>('SELECT * FROM audit_log WHERE seq > $1 AND home_id = $2 ORDER BY seq LIMIT $3', [opts.afterSeq ?? 0, opts.homeId, limit])
      : await this.db.query<Row>('SELECT * FROM audit_log WHERE seq > $1 ORDER BY seq LIMIT $2', [opts.afterSeq ?? 0, limit]);
    return rows.map(toRecord);
  }

  /** Recomputes the chain from the anchor. Returns the first broken seq, if any. */
  async verify(): Promise<{ ok: true; count: number; head: string } | { ok: false; brokenAt: number; reason: string }> {
    let prev = await this.anchor(this.db);
    let count = 0;
    let after = 0;
    for (;;) {
      const rows = await this.db.query<Row>('SELECT * FROM audit_log WHERE seq > $1 ORDER BY seq LIMIT 1000', [after]);
      if (rows.length === 0) break;
      for (const row of rows) {
        if (row.prev_hash !== prev) return { ok: false, brokenAt: Number(row.seq), reason: 'previous hash does not match' };
        if (auditHash(prev, toRecord(row), row.details) !== row.hash) {
          return { ok: false, brokenAt: Number(row.seq), reason: 'record hash does not match its content' };
        }
        prev = row.hash;
        count++;
        after = Number(row.seq);
      }
    }
    return { ok: true, count, head: prev };
  }

  onAppend(listener: (r: AuditRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async anchor(db: Db): Promise<string> {
    const [row] = await db.query<{ value: string }>("SELECT value FROM cloud_meta WHERE key = 'audit_anchor'");
    return row?.value ?? GENESIS_HASH;
  }
}

function toRecord(r: Row): AuditRecord {
  return {
    seq: Number(r.seq),
    id: r.id,
    at: Number(r.at),
    actor: r.actor,
    action: r.action,
    outcome: r.outcome,
    target: r.target,
    homeId: r.home_id,
    details: JSON.parse(r.details) as Record<string, unknown>,
    prevHash: r.prev_hash,
    hash: r.hash,
  };
}
