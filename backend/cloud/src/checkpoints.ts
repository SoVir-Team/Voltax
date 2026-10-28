import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import type { CloudAudit } from './audit.js';
import type { Db } from './db.js';
import type { EnvelopeSigner } from './signer.js';

export interface Checkpoint {
  id: number;
  at: number;
  lastSeq: number;
  headHash: string;
  keyId: string;
  signature: string;
}

export function checkpointText(c: Pick<Checkpoint, 'at' | 'lastSeq' | 'headHash'>): string {
  return `voltax-audit-checkpoint:v1:${c.lastSeq}:${c.headHash}:${c.at}`;
}

/** True when the checkpoint was signed by the holder of the private half of `publicKey`. */
export function checkpointSignatureValid(c: Pick<Checkpoint, 'at' | 'lastSeq' | 'headHash' | 'signature'>, publicKey: string | KeyObject): boolean {
  const pub = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey;
  return verify(null, Buffer.from(checkpointText(c)), pub, Buffer.from(c.signature, 'base64'));
}

/**
 * Signed statements of the audit chain head. The checkpoint key lives outside the database, so
 * someone who can rewrite the database (and re-hash the whole chain) still cannot produce matching
 * checkpoints; and the exported copies hold earlier checkpoints out of their reach.
 */
export class AuditCheckpoints {
  constructor(
    private db: Db,
    private audit: CloudAudit,
    private key: EnvelopeSigner | null,
  ) {}

  async create(): Promise<Checkpoint | null> {
    if (!this.key) return null;
    const [head] = await this.db.query<{ seq: number; hash: string }>('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1');
    if (!head) return null;
    const [last] = await this.db.query<{ last_seq: number }>('SELECT last_seq FROM audit_checkpoints ORDER BY id DESC LIMIT 1');
    if (last && Number(last.last_seq) === Number(head.seq)) return null; // nothing new
    const at = Date.now();
    const body = { at, lastSeq: Number(head.seq), headHash: head.hash };
    const signature = this.key.signText(checkpointText(body));
    const [row] = await this.db.query<{ id: number }>('INSERT INTO audit_checkpoints (at, last_seq, head_hash, key_id, signature) VALUES ($1, $2, $3, $4, $5) RETURNING id', [
      at,
      body.lastSeq,
      body.headHash,
      this.key.keyId,
      signature,
    ]);
    return { id: Number(row!.id), ...body, keyId: this.key.keyId, signature };
  }

  async list(limit = 50): Promise<Checkpoint[]> {
    const rows = await this.db.query<{ id: number; at: number; last_seq: number; head_hash: string; key_id: string; signature: string }>(
      'SELECT * FROM audit_checkpoints ORDER BY id DESC LIMIT $1',
      [limit],
    );
    return rows.map((r) => ({ id: Number(r.id), at: Number(r.at), lastSeq: Number(r.last_seq), headHash: r.head_hash, keyId: r.key_id, signature: r.signature }));
  }

  /**
   * Full verification: the chain recomputes, every checkpoint signature is valid for the given
   * public key, and every checkpointed head is still the hash stored at that sequence number.
   */
  async verify(publicKeyPem: string | null): Promise<{ ok: boolean; chain: Awaited<ReturnType<CloudAudit['verify']>>; checkpoints: number; problems: string[] }> {
    const chain = await this.audit.verify();
    const problems: string[] = [];
    if (!chain.ok) problems.push(`chain broken at seq ${chain.brokenAt}: ${chain.reason}`);
    const all = await this.db.query<{ id: number; at: number; last_seq: number; head_hash: string; signature: string }>('SELECT * FROM audit_checkpoints ORDER BY id');
    const pub = publicKeyPem ? createPublicKey(publicKeyPem) : null;
    for (const c of all) {
      const body = { at: Number(c.at), lastSeq: Number(c.last_seq), headHash: c.head_hash };
      if (pub && !checkpointSignatureValid({ ...body, signature: c.signature }, pub)) problems.push(`checkpoint ${c.id}: bad signature`);
      const [row] = await this.db.query<{ hash: string }>('SELECT hash FROM audit_log WHERE seq = $1', [body.lastSeq]);
      if (!row) problems.push(`checkpoint ${c.id}: record ${body.lastSeq} is missing`);
      else if (row.hash !== body.headHash) problems.push(`checkpoint ${c.id}: record ${body.lastSeq} was changed after it was checkpointed`);
    }
    if (!pub) problems.push('no checkpoint public key configured: signatures not checked');
    return { ok: problems.length === 0, chain, checkpoints: all.length, problems };
  }
}
