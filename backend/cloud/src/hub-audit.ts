import { createHash } from 'node:crypto';
import type { HubAuditRecord } from '@voltax/contracts';
import type { CloudAudit } from './audit.js';
import type { Db } from './db.js';

const GENESIS = '0'.repeat(64);

/** Same formula as backend/hub/src/audit.ts auditHash. */
export function hubAuditHash(prevHash: string, r: Pick<HubAuditRecord, 'id' | 'at' | 'actor' | 'action' | 'outcome' | 'target' | 'details'>): string {
  const canonical = JSON.stringify([r.id, r.at, r.actor, r.action, r.outcome, r.target, r.details]);
  return createHash('sha256').update(prevHash).update('\n').update(canonical).digest('hex');
}

/**
 * Off-device copy of every hub's audit chain. Each record is checked on arrival: it must link to the
 * previous stored record and its hash must recompute. A record that differs from one already stored
 * for the same sequence number means the hub's log was rewritten: that is raised, never overwritten.
 */
export class HubAuditStore {
  constructor(
    private db: Db,
    private audit: CloudAudit,
    private now: () => number = Date.now,
  ) {}

  async ingest(hubId: string, records: HubAuditRecord[]): Promise<{ stored: number; duplicates: number; conflicts: number; breaks: number }> {
    const result = { stored: 0, duplicates: 0, conflicts: 0, breaks: 0 };
    for (const r of [...records].sort((a, b) => a.seq - b.seq)) {
      const [existing] = await this.db.query<{ hash: string }>('SELECT hash FROM hub_audit WHERE hub_id = $1 AND seq = $2', [hubId, r.seq]);
      if (existing) {
        if (existing.hash === r.hash) result.duplicates++;
        else {
          result.conflicts++;
          await this.audit.append({ actor: `hub:${hubId}`, action: 'hub_audit.conflict', outcome: 'error', target: `hub:${hubId}`, details: { seq: r.seq, reason: 'record differs from the stored copy' } });
        }
        continue;
      }
      const [prev] = await this.db.query<{ seq: number; hash: string }>('SELECT seq, hash FROM hub_audit WHERE hub_id = $1 AND seq < $2 ORDER BY seq DESC LIMIT 1', [hubId, r.seq]);
      const expectedPrev = prev ? (Number(prev.seq) === r.seq - 1 ? prev.hash : null) : r.seq === 1 ? GENESIS : null;
      const chainOk = expectedPrev === r.prevHash && hubAuditHash(r.prevHash, r) === r.hash;
      await this.db.query(
        `INSERT INTO hub_audit (hub_id, seq, id, at, actor, action, outcome, target, details, prev_hash, hash, chain_ok, received_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [hubId, r.seq, r.id, r.at, r.actor, r.action, r.outcome, r.target, JSON.stringify(r.details), r.prevHash, r.hash, chainOk, this.now()],
      );
      result.stored++;
      if (!chainOk) {
        result.breaks++;
        await this.audit.append({
          actor: `hub:${hubId}`,
          action: 'hub_audit.chain_break',
          outcome: 'error',
          target: `hub:${hubId}`,
          details: { seq: r.seq, reason: expectedPrev === null ? 'gap before this record' : 'hash does not link or recompute' },
        });
      }
    }
    return result;
  }

  async list(hubId: string, afterSeq = 0, limit = 200): Promise<Array<HubAuditRecord & { chainOk: boolean }>> {
    const rows = await this.db.query<{ seq: number; id: string; at: number; actor: string; action: string; outcome: HubAuditRecord['outcome']; target: string | null; details: string; prev_hash: string; hash: string; chain_ok: boolean }>(
      'SELECT * FROM hub_audit WHERE hub_id = $1 AND seq > $2 ORDER BY seq LIMIT $3',
      [hubId, afterSeq, Math.min(limit, 500)],
    );
    return rows.map((r) => ({
      seq: Number(r.seq),
      id: r.id,
      at: Number(r.at),
      actor: r.actor,
      action: r.action,
      outcome: r.outcome,
      target: r.target,
      details: JSON.parse(r.details) as Record<string, unknown>,
      prevHash: r.prev_hash,
      hash: r.hash,
      chainOk: r.chain_ok,
    }));
  }

  async summary(hubId: string): Promise<{ records: number; lastSeq: number; breaks: number }> {
    const [r] = await this.db.query<{ n: number; last: number | null; breaks: number }>(
      'SELECT count(*)::int AS n, max(seq) AS last, count(*) FILTER (WHERE NOT chain_ok)::int AS breaks FROM hub_audit WHERE hub_id = $1',
      [hubId],
    );
    return { records: r?.n ?? 0, lastSeq: Number(r?.last ?? 0), breaks: r?.breaks ?? 0 };
  }
}
