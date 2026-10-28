import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { pgUrl, startCloud } from './helpers.js';
import type { ObjectStore } from '../src/s3.js';

// Runs the BUILT command-line tool (node dist/cli.js), as an operator or auditor would.
const root = new URL('..', import.meta.url);
const cli = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, ['dist/cli.js', ...args], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', ...env } });
let dir: string;

beforeAll(() => {
  const build = spawnSync(process.execPath, ['../../node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { cwd: root, encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`build failed: ${build.stdout}${build.stderr}`);
  dir = mkdtempSync(join(tmpdir(), 'voltax-cli-'));
}, 120_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('cloud CLI', () => {
  it('generates signing keys with private-only permissions and never overwrites one', () => {
    const out = join(dir, 'cloud-audit.key');
    const first = cli(['gen-audit-key', '--out', out]);
    expect(first.status).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain('BEGIN PRIVATE KEY');
    expect(readFileSync(`${out}.pub`, 'utf8')).toContain('BEGIN PUBLIC KEY');
    const again = cli(['gen-audit-key', '--out', out]);
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/refusing to overwrite/);
  });

  it('prints a VAPID key pair for the env file', () => {
    const r = cli(['gen-vapid-keys']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^VAPID_PUBLIC_KEY=[A-Za-z0-9_-]{80,}\nVAPID_PRIVATE_KEY=[A-Za-z0-9_-]{40,}\n/);
  });

  it('verify-export checks an exported copy offline: intact passes, any edit or wrong key fails', async () => {
    const auditKey = generateKeyPairSync('ed25519');
    const objects = new Map<string, string>();
    const store: ObjectStore = { put: async (k, b) => void objects.set(k, b), get: async (k) => objects.get(k) ?? null };
    const c = await startCloud({ extra: { objectStore: store, auditKeyPem: auditKey.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() } });
    try {
      const admin = await c.addStaff('PLATFORM_SUPER_ADMIN');
      await c.req('POST', '/api/v1/homes', { cookie: admin.cookie, body: { name: 'Exported' } });
      const exported = (await c.auditExport.runOnce())!;
      const file = join(dir, 'export.jsonl');
      const pub = join(dir, 'audit.pub');
      writeFileSync(file, objects.get(exported.key)!);
      writeFileSync(pub, auditKey.publicKey.export({ type: 'spki', format: 'pem' }));

      const ok = cli(['verify-export', '--file', file, '--pubkey', pub]);
      expect(ok.status).toBe(0);
      expect(JSON.parse(ok.stdout)).toMatchObject({ ok: true, records: exported.records, checkpointSignatureValid: true });

      const original = objects.get(exported.key)!;
      expect(original).toContain('"action":"home.create"');
      writeFileSync(file, original.replace('"action":"home.create"', '"action":"home.update"'));
      const edited = cli(['verify-export', '--file', file, '--pubkey', pub]);
      expect(edited.status).toBe(2);
      expect(JSON.parse(edited.stdout).problem).toMatch(/hash does not recompute/);

      writeFileSync(file, objects.get(exported.key)!);
      writeFileSync(pub, generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }));
      const wrongKey = cli(['verify-export', '--file', file, '--pubkey', pub]);
      expect(wrongKey.status).toBe(2);
      expect(JSON.parse(wrongKey.stdout)).toMatchObject({ ok: true, checkpointSignatureValid: false });
    } finally {
      await c.close();
    }
  });

  it.skipIf(!process.env.VOLTAX_TEST_PG_ADMIN)('on PostgreSQL: migrate as owner, then bootstrap and verify as the restricted app role', async () => {
    const admin = process.env.VOLTAX_TEST_PG_ADMIN!;
    const name = `voltax_cli_${Date.now()}`;
    const client = new pg.Client({ connectionString: admin });
    await client.connect();
    await client.query(`CREATE DATABASE ${name} OWNER voltax_owner`);
    await client.end();
    const key = join(dir, 'pg-audit.key');
    expect(cli(['gen-audit-key', '--out', key]).status).toBe(0);
    const env = (role: string) => ({ DATABASE_URL: pgUrl(admin, name, role), CLOUD_DATA_KEY: 'b'.repeat(64), AUDIT_KEY_FILE: key, PUBLIC_ORIGIN: 'https://portal.voltex.example' });

    expect(cli(['bootstrap-admin', '--email', 'ops@voltex.example', '--name', 'Ops'], env('voltax_app')).status).toBe(1); // not migrated yet
    expect(cli(['migrate'], env('voltax_app')).status).toBe(1); // the app role cannot change the schema
    const migrated = cli(['migrate'], env('voltax_owner'));
    expect(migrated.stdout).toContain('migrations applied');
    const boot = cli(['bootstrap-admin', '--email', 'ops@voltex.example', '--name', 'Ops'], env('voltax_app'));
    expect(boot.stdout).toMatch(/https:\/\/portal\.voltex\.example\/setup#\S{20,}/);
    expect(cli(['bootstrap-admin', '--email', 'other@voltex.example', '--name', 'Other'], env('voltax_app')).status).toBe(1); // only once
    const verify = cli(['audit-verify'], env('voltax_app'));
    expect(verify.status).toBe(0);
    expect(JSON.parse(verify.stdout)).toMatchObject({ ok: true, problems: [] });
  });

  it('refuses to start database commands with an incomplete configuration, naming only the missing setting', () => {
    const r = cli(['audit-verify'], { DATABASE_URL: 'postgres://x@127.0.0.1:1/x', CLOUD_DATA_KEY: 'k', SMTP_URL: 'smtp://u:TopSecret@h' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/SMTP_FROM/);
    expect(r.stderr).not.toContain('TopSecret');
    expect(existsSync(join(dir, 'never'))).toBe(false);
  });
});
