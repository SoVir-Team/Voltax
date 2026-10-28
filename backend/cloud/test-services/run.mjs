// npm run test:services -w backend/cloud
// Runs test/services.test.ts against real local stand-ins for the external services, in Docker:
//   Mailpit  (axllent/mailpit)      SMTP delivery; only @example.test recipients accepted, so a
//                                   refused recipient (550) can be tested too.
//   S3       (versity/versitygw)    S3-compatible storage with versioning + Object Lock, for the
//                                   off-device audit copy. (MinIO no longer publishes images.)
// Throwaway containers on 127.0.0.1 with random per-run credentials; removed afterwards.
// A missing prerequisite FAILS the run.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';

const MAILPIT = process.env.VOLTAX_TEST_MAILPIT_IMAGE ?? 'axllent/mailpit:v1.27';
const S3 = process.env.VOLTAX_TEST_S3_IMAGE ?? 'versity/versitygw:v1.10.0';
const env = { ...process.env, MSYS_NO_PATHCONV: '1' };
const docker = (args) => spawnSync('docker', args, { encoding: 'utf8', env });
const freePort = () =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
async function until(check, what, timeoutMs = 60_000) {
  const start = Date.now();
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() - start > timeoutMs) throw new Error(`${what} did not become ready`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

if (docker(['info', '--format', '{{.ServerVersion}}']).status !== 0) {
  console.error('FAIL: Docker engine not reachable (docker info failed); start Docker Desktop');
  process.exit(1);
}

const tag = randomBytes(4).toString('hex');
const names = [];
let status = 1;
try {
  const smtp = await freePort();
  const http = await freePort();
  const mail = `voltax-test-mailpit-${tag}`;
  let r = docker(['run', '-d', '--rm', '--name', mail, '-p', `127.0.0.1:${smtp}:1025`, '-p', `127.0.0.1:${http}:8025`, MAILPIT, '--smtp-allowed-recipients', '@example\\.test$']);
  if (r.status !== 0) throw new Error(`mailpit: ${r.stderr}`);
  names.push(mail);

  const s3port = await freePort();
  const key = randomBytes(10).toString('hex');
  const secret = randomBytes(24).toString('hex');
  const s3 = `voltax-test-s3-${tag}`;
  r = docker(['run', '-d', '--rm', '--name', s3, '-p', `127.0.0.1:${s3port}:7070`, '-v', '/gw', '-v', '/versions', '-e', `ROOT_ACCESS_KEY=${key}`, '-e', `ROOT_SECRET_KEY=${secret}`, S3, 'posix', '--versioning-dir', '/versions', '/gw']);
  if (r.status !== 0) throw new Error(`s3: ${r.stderr}`);
  names.push(s3);

  await until(async () => (await fetch(`http://127.0.0.1:${http}/api/v1/info`)).ok, 'mailpit');
  await until(async () => (await fetch(`http://127.0.0.1:${s3port}/`)).status > 0, 's3');
  console.log(`mailpit ${MAILPIT} smtp:${smtp} http:${http}; s3 ${S3} :${s3port}`);

  const vitest = spawnSync(process.execPath, ['../../node_modules/vitest/vitest.mjs', 'run', 'test/services.test.ts'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      VOLTAX_TEST_SMTP_URL: `smtp://127.0.0.1:${smtp}`,
      VOLTAX_TEST_MAILPIT_API: `http://127.0.0.1:${http}`,
      VOLTAX_TEST_S3_ENDPOINT: `http://127.0.0.1:${s3port}`,
      VOLTAX_TEST_S3_BUCKET: `voltax-audit-${tag}`,
      VOLTAX_TEST_S3_KEY: key,
      VOLTAX_TEST_S3_SECRET: secret,
    },
  });
  status = vitest.status ?? 1;
} catch (err) {
  console.error(`FAIL: ${err.message}`);
} finally {
  for (const n of names) docker(['rm', '-f', n]);
}
process.exit(status);
