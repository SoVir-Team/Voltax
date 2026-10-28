import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type DB = Database.Database;

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

export function openDb(path: string, opts: { backupDir?: string; migrationsDir?: string } = {}): DB {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL'); // committed writes survive power loss
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db, opts.migrationsDir ?? MIGRATIONS_DIR, opts.backupDir);
  return db;
}

/** Forward-only migrations named NNN_name.sql; schema version lives in PRAGMA user_version. */
export function migrate(db: DB, dir: string, backupDir?: string): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  const pending = readdirSync(dir)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .sort()
    .map((f) => ({ version: Number.parseInt(f, 10), file: join(dir, f) }))
    .filter((m) => m.version > current);
  if (pending.length === 0) return;

  // Consistent copy (works in WAL mode) before touching an existing schema.
  if (current > 0 && backupDir) {
    mkdirSync(backupDir, { recursive: true });
    const target = join(backupDir, `pre-migration-v${current}-${Date.now()}.db`);
    db.prepare('VACUUM INTO ?').run(target);
  }

  for (const m of pending) {
    const sql = readFileSync(m.file, 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${m.version}`);
    })();
  }
}

export function schemaVersion(db: DB): number {
  return db.pragma('user_version', { simple: true }) as number;
}
