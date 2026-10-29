// npm run test:pg -w backend/cloud
// Runs the whole cloud test suite against a REAL, throwaway PostgreSQL server instead of PGlite:
// a fresh cluster in a temp folder, its own port, listening on 127.0.0.1 only, trust auth for local
// connections (no passwords, nothing persists), stopped and deleted afterwards.
// Needs PostgreSQL server binaries: PG_BIN (default: C:\Program Files\PostgreSQL\18\bin on Windows,
// otherwise initdb/pg_ctl/psql from PATH). CI sets PG_BIN=/usr/lib/postgresql/18/bin.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const bin = process.env.PG_BIN ?? (process.platform === 'win32' ? 'C:\\Program Files\\PostgreSQL\\18\\bin' : '');
const exe = (name) => (bin ? join(bin, process.platform === 'win32' ? `${name}.exe` : name) : name);
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(exe(cmd), args, { encoding: 'utf8', timeout: 120_000, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
};

const port = await new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
const dir = mkdtempSync(join(tmpdir(), 'voltax-pg-'));
const data = join(dir, 'data');
let started = false;
let status;
try {
  run('initdb', ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--no-instructions']);
  // stdio ignored: the server keeps inherited handles open, which would block spawnSync forever.
  // Unix sockets go in the temp folder: the packaged default (/var/run/postgresql) is not ours to write.
  const sockets = process.platform === 'win32' ? '' : ` -k ${dir}`;
  const log = join(dir, 'server.log');
  const start = spawnSync(exe('pg_ctl'), ['-D', data, '-l', log, '-o', `-p ${port} -c listen_addresses=127.0.0.1${sockets}`, '-w', 'start'], { stdio: 'ignore', timeout: 60_000 });
  if (start.status !== 0) throw new Error(`pg_ctl start failed:\n${existsSync(log) ? readFileSync(log, 'utf8') : '(no server.log)'}`);
  started = true;
  const psql = (sql) => run('psql', ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
  console.log(psql('SELECT version()').split('\n')[2]?.trim());
  psql('CREATE ROLE voltax_owner LOGIN CREATEDB; CREATE ROLE voltax_app LOGIN; CREATE ROLE voltax_audit_reader LOGIN;');

  const vitest = spawnSync(process.execPath, ['../../node_modules/vitest/vitest.mjs', 'run', ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, VOLTAX_TEST_PG_ADMIN: `postgres://postgres@127.0.0.1:${port}/postgres` },
  });
  status = vitest.status ?? 1;
} finally {
  if (started) spawnSync(exe('pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' });
  rmSync(dir, { recursive: true, force: true });
}
process.exit(status);
