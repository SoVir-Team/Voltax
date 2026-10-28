import { auditHash, type AuditRecord, type CloudAudit } from './audit.js';
import type { AuditCheckpoints, Checkpoint } from './checkpoints.js';
import type { Db } from './db.js';
import type { ObjectStore } from './s3.js';

const BATCH = 1000;
export const EXPORT_PREFIX = 'voltax-audit/';

/**
 * Copies the cloud audit chain to off-device storage in order, with a signed checkpoint at the end
 * of every object. With Object Lock (COMPLIANCE) on the bucket, nobody — including VOLTEX admins —
 * can change or delete an exported object until its retention ends.
 */
export class AuditExport {
  constructor(
    private db: Db,
    private audit: CloudAudit,
    private checkpoints: AuditCheckpoints,
    private store: ObjectStore | null,
  ) {}

  get enabled(): boolean {
    return this.store !== null;
  }

  async cursor(): Promise<number> {
    const [row] = await this.db.query<{ value: string }>("SELECT value FROM cloud_meta WHERE key = 'audit_exported_seq'");
    return Number(row?.value ?? 0);
  }

  /** Exports the next batch. Returns the object key, or null when there was nothing new. */
  async runOnce(): Promise<{ key: string; records: number } | null> {
    if (!this.store) return null;
    const after = await this.cursor();
    const records = await this.audit.list({ afterSeq: after, limit: BATCH });
    if (records.length === 0) return null;
    // A fresh signed checkpoint, or the latest one if the head was already checkpointed.
    const checkpoint = (await this.checkpoints.create()) ?? (await this.checkpoints.list(1))[0] ?? null;
    const first = records[0]!.seq;
    const last = records[records.length - 1]!.seq;
    const key = `${EXPORT_PREFIX}${String(first).padStart(12, '0')}-${String(last).padStart(12, '0')}.jsonl`;
    const lines = records.map((r) => JSON.stringify(r));
    if (checkpoint) lines.push(JSON.stringify({ checkpoint }));
    try {
      await this.store.put(key, `${lines.join('\n')}\n`);
    } catch (err) {
      await this.audit.append({ actor: 'system', action: 'audit.export', outcome: 'error', details: { from: first, to: last, error: (err as Error).message.slice(0, 160) } });
      throw err;
    }
    // Only advance after the object is stored: a crash before this line re-exports, never skips.
    await this.db.query("UPDATE cloud_meta SET value = $1 WHERE key = 'audit_exported_seq'", [String(last)]);
    return { key, records: records.length };
  }

  /** Exports until caught up. */
  async runAll(): Promise<number> {
    let n = 0;
    for (let r = await this.runOnce(); r; r = await this.runOnce()) n += r.records;
    return n;
  }
}

/**
 * Checks an exported object on its own: records are consecutive, each hash recomputes and links to
 * the previous one (prevHash of the first record must equal `expectedPrev` when given).
 */
export function verifyExportedObject(text: string, expectedPrev?: string): { ok: boolean; records: number; head: string | null; checkpoint: Checkpoint | null; problem?: string } {
  let prev = expectedPrev ?? null;
  let count = 0;
  let checkpoint: Checkpoint | null = null;
  let lastSeq: number | null = null;
  for (const line of text.split('\n').filter(Boolean)) {
    const obj = JSON.parse(line) as AuditRecord | { checkpoint: Checkpoint };
    if ('checkpoint' in obj) {
      checkpoint = obj.checkpoint;
      continue;
    }
    if (prev !== null && obj.prevHash !== prev) return { ok: false, records: count, head: prev, checkpoint, problem: `record ${obj.seq} does not link to the previous one` };
    if (lastSeq !== null && obj.seq !== lastSeq + 1) return { ok: false, records: count, head: prev, checkpoint, problem: `gap before record ${obj.seq}` };
    if (auditHash(obj.prevHash, obj, JSON.stringify(obj.details)) !== obj.hash) return { ok: false, records: count, head: prev, checkpoint, problem: `record ${obj.seq} hash does not recompute` };
    prev = obj.hash;
    lastSeq = obj.seq;
    count++;
  }
  if (checkpoint && checkpoint.lastSeq === lastSeq && checkpoint.headHash !== prev) {
    return { ok: false, records: count, head: prev, checkpoint, problem: 'checkpoint does not match the exported head' };
  }
  return { ok: true, records: count, head: prev, checkpoint };
}
