import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openDb, schemaVersion } from '../src/db.js';
import { RELAY, pairOwner, startEnv, waitFor } from './helpers.js';

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'voltax-db-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('database', () => {
  it('opens in WAL mode with synchronous=FULL', () => {
    const db = openDb(join(tempDir(), 'hub.db'));
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('synchronous', { simple: true })).toBe(2); // FULL
    expect(schemaVersion(db)).toBeGreaterThanOrEqual(1);
    db.close();
  });

  it('backs up an existing schema before applying a new migration', () => {
    const dir = tempDir();
    const db = openDb(join(dir, 'hub.db'), { backupDir: join(dir, 'backups') });
    const migrations = join(dir, 'migrations');
    rmSync(migrations, { recursive: true, force: true });
    mkdirSync(migrations);
    copyFileSync(new URL('../migrations/001_init.sql', import.meta.url), join(migrations, '001_init.sql'));
    writeFileSync(join(migrations, '002_extra.sql'), 'CREATE TABLE extra (id INTEGER);');
    migrate(db, migrations, join(dir, 'backups'));
    expect(schemaVersion(db)).toBe(2);
    const backups = readdirSync(join(dir, 'backups'));
    expect(backups.some((f) => f.startsWith('pre-migration-v1'))).toBe(true);
    const copy = new Database(join(dir, 'backups', backups[0]!), { readonly: true });
    expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
    copy.close();
    db.close();
  });

  it('keeps state, pairing and devices across a hub restart', async () => {
    const dir = tempDir();
    const first = await startEnv({ dir });
    const owner = await pairOwner(first.hub);
    await first.device.setRelay(true);
    await waitFor(() => first.hub.store.getEntity(RELAY)?.state === true);
    await first.close();

    const second = await startEnv({ dir, connectDevice: false });
    expect(second.hub.store.getEntity(RELAY)?.state).toBe(true);
    const res = await second.hub.app.inject({ method: 'GET', url: '/api/v1/devices', headers: owner });
    expect(res.statusCode).toBe(200);
    await second.close();
  });
});
