import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * The few things the cloud needs from Postgres. Production uses `pg` (a real server); unit tests use
 * PGlite (Postgres compiled to WASM, in-process), so the same SQL, triggers and plpgsql run in both.
 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Runs fn in one transaction. Nested calls reuse the outer transaction. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  /** Multi-statement SQL without parameters (migrations). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

// bigint columns hold epoch milliseconds and counters: well inside Number range.
const INT8_OID = 20;
pg.types.setTypeParser(INT8_OID, (v) => Number(v));

export function pgDb(connectionString: string, max = 10): Db {
  const pool = new pg.Pool({ connectionString, max });
  const viaClient = (client: pg.PoolClient): Db => ({
    query: async (sql, params) => (await client.query(sql, params)).rows,
    tx: (fn) => fn(viaClient(client)),
    exec: async (sql) => void (await client.query(sql)),
    close: async () => undefined,
  });
  return {
    query: async (sql, params) => (await pool.query(sql, params)).rows,
    exec: async (sql) => void (await pool.query(sql)),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(viaClient(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** In-process Postgres for tests and the load-test simulator. Dev dependency only. */
export async function pgliteDb(): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const lite = await PGlite.create({ parsers: { [INT8_OID]: (v: string) => Number(v) } });
  type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>; exec: (sql: string) => Promise<unknown> };
  const wrap = (q: Q, inTx: boolean): Db => ({
    query: async <T>(sql: string, params?: unknown[]) => (await q.query(sql, params)).rows as T[],
    exec: async (sql) => void (await q.exec(sql)),
    tx: (fn) => (inTx ? fn(wrap(q, true)) : lite.transaction((t) => fn(wrap(t as unknown as Q, true)))),
    close: async () => (inTx ? undefined : lite.close()),
  });
  return wrap(lite as unknown as Q, false);
}

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

/** Applies migrations/NNN_*.sql in order, each once, each in its own transaction. */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at bigint NOT NULL)');
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name));
  const applied: string[] = [];
  for (const name of readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort()) {
    if (done.has(name)) continue;
    const sql = readFileSync(`${dir}${name}`, 'utf8');
    await db.tx(async (t) => {
      await t.exec(sql);
      await t.query('INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)', [name, Date.now()]);
    });
    applied.push(name);
  }
  return applied;
}
