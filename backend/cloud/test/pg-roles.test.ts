import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CloudAudit } from '../src/audit.js';
import { migrate, pgDb, type Db } from '../src/db.js';
import { pgUrl, startCloud } from './helpers.js';

// Real PostgreSQL only (npm run test:pg): role separation and concurrency that PGlite cannot show.
const admin = process.env.VOLTAX_TEST_PG_ADMIN;

describe.skipIf(!admin)('PostgreSQL 18: roles, privileges and concurrency', () => {
  let name: string;
  let owner: Db;
  let app: Db;
  let reader: Db;

  beforeAll(async () => {
    name = `voltax_roles_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    const client = new pg.Client({ connectionString: admin });
    await client.connect();
    await client.query(`CREATE DATABASE ${name} OWNER voltax_owner`);
    await client.end();
    owner = pgDb(pgUrl(admin!, name, 'voltax_owner'));
    await migrate(owner);
    app = pgDb(pgUrl(admin!, name, 'voltax_app'), 12);
    reader = pgDb(pgUrl(admin!, name, 'voltax_audit_reader'));
  });
  afterAll(async () => {
    await Promise.all([owner?.close(), app?.close(), reader?.close()]);
  });

  it('runs on PostgreSQL 18', async () => {
    const [v] = await owner.query<{ server_version: string }>('SHOW server_version');
    expect(v!.server_version).toMatch(/^18\./);
  });

  it('the app role can append audit records but cannot change, delete, truncate or unprotect them', async () => {
    await new CloudAudit(app).append({ actor: 'system', action: 'pg.test', outcome: 'ok' });
    for (const table of ['audit_log', 'hub_audit', 'audit_checkpoints']) {
      await expect(app.query(`UPDATE ${table} SET at = 0`)).rejects.toThrow(/permission denied/);
      await expect(app.query(`DELETE FROM ${table}`)).rejects.toThrow(/permission denied/);
      await expect(app.query(`TRUNCATE ${table}`)).rejects.toThrow(/permission denied/);
      await expect(app.exec(`ALTER TABLE ${table} DISABLE TRIGGER ALL`)).rejects.toThrow(/must be owner/);
    }
    await expect(app.query('DELETE FROM schema_migrations')).rejects.toThrow(/permission denied/);
  });

  it('even the owner hits the append-only triggers', async () => {
    await expect(owner.query("UPDATE audit_log SET actor = 'x'")).rejects.toThrow(/append-only/);
    await expect(owner.query('TRUNCATE audit_log')).rejects.toThrow(/append-only/);
  });

  it('the audit reader can read the audit tables and nothing else', async () => {
    expect((await reader.query('SELECT count(*) FROM audit_log')).length).toBe(1);
    await expect(reader.query('SELECT * FROM staff')).rejects.toThrow(/permission denied/);
    await expect(reader.query("INSERT INTO cloud_meta (key, value) VALUES ('x', 'y')")).rejects.toThrow(/permission denied/);
  });

  it('200 concurrent appends from 12 connections keep one unbroken chain (advisory lock)', async () => {
    const audit = new CloudAudit(app);
    await Promise.all(Array.from({ length: 200 }, (_, i) => audit.append({ actor: 'system', action: `concurrent.${i}`, outcome: 'ok' })));
    const v = await audit.verify();
    expect(v.ok).toBe(true);
    const [n] = await app.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'concurrent.%'");
    expect(n!.n).toBe(200);
  });

  it('the whole cloud works as the restricted app role (migrations off)', async () => {
    const c = await startCloud({ db: pgDb(pgUrl(admin!, name, 'voltax_app')), extra: { migrate: false } });
    try {
      const s = await c.addStaff('PLATFORM_SUPER_ADMIN');
      const home = (await c.req('POST', '/api/v1/homes', { cookie: s.cookie, body: { name: 'Role test' } })).body.homeId;
      expect((await c.req('GET', `/api/v1/homes/${home}`, { cookie: s.cookie })).status).toBe(200);
      const verify = await c.req('POST', '/api/v1/audit/verify', { cookie: s.cookie });
      expect(verify.body.chain.ok).toBe(true);
    } finally {
      await c.close();
    }
  });
});
