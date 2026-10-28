import { randomUUID } from 'node:crypto';
import type { HubEvent, HubEventType } from '@voltax/contracts';
import type { DB } from './db.js';

type Listener = (event: HubEvent) => void;

interface EventRow {
  seq: number;
  id: string;
  type: HubEventType;
  payload: string;
  created_at: number;
}

/** Append-only event log. `seq` is the ordering key for clients and cloud sync (never wall-clock time). */
export class EventLog {
  private listeners = new Set<Listener>();
  private insert;
  private selectSince;

  constructor(private db: DB) {
    this.insert = db.prepare('INSERT INTO events (id, type, payload, created_at) VALUES (?, ?, ?, ?)');
    this.selectSince = db.prepare('SELECT seq, id, type, payload, created_at FROM events WHERE seq > ? ORDER BY seq LIMIT ?');
  }

  append(type: HubEventType, payload: Record<string, unknown>): HubEvent {
    const id = randomUUID();
    const createdAt = Date.now();
    const result = this.insert.run(id, type, JSON.stringify(payload), createdAt);
    const event: HubEvent = { seq: Number(result.lastInsertRowid), id, type, payload, createdAt };
    for (const listener of this.listeners) listener(event);
    return event;
  }

  since(afterSeq: number, limit = 1000): HubEvent[] {
    return (this.selectSince.all(afterSeq, limit) as EventRow[]).map((r) => ({
      seq: r.seq,
      id: r.id,
      type: r.type,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
      createdAt: r.created_at,
    }));
  }

  lastSeq(): number {
    const row = this.db.prepare('SELECT MAX(seq) AS seq FROM events').get() as { seq: number | null };
    return row.seq ?? 0;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  prune(olderThanMs: number): number {
    return this.db.prepare('DELETE FROM events WHERE created_at < ?').run(Date.now() - olderThanMs).changes;
  }
}
