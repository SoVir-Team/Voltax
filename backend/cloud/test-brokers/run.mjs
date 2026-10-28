// npm run test:brokers -w backend/cloud
// Repeats the end-to-end support lifecycle (test/e2e.test.ts: real cloud + real hub) on REAL brokers:
//   mosquitto  native Mosquitto as the cloud broker (ACL file equivalent of brokerAllows), and the
//              hub's local broker on Mosquitto with the deploy/pi ACL. Separate processes on their
//              own ports with their own config; an installed Mosquitto service is never touched.
//              MOSQUITTO_DIR (default C:\Program Files\mosquitto on Windows, else PATH).
//   emqx       EMQX in Docker (VOLTAX_TEST_EMQX_IMAGE, default emqx/emqx:5.8.6) authenticating and
//              authorising through the cloud's internal /broker/authn + /broker/authz API.
// A missing prerequisite FAILS the run; nothing is skipped silently.
// Usage: node test-brokers/run.mjs [mosquitto] [emqx]
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const kinds = process.argv.slice(2).length ? process.argv.slice(2) : ['mosquitto', 'emqx'];
const mosqDir = process.env.MOSQUITTO_DIR ?? (process.platform === 'win32' ? 'C:\\Program Files\\mosquitto' : '');

function prerequisite(kind) {
  if (kind === 'mosquitto') {
    const exe = mosqDir ? join(mosqDir, process.platform === 'win32' ? 'mosquitto.exe' : 'mosquitto') : 'mosquitto';
    const r = spawnSync(exe, ['-h'], { encoding: 'utf8' });
    if (r.error || (mosqDir && !existsSync(exe))) return `Mosquitto not found (${exe}); set MOSQUITTO_DIR`;
    return null;
  }
  if (kind === 'emqx') {
    const r = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' });
    if (r.status !== 0) return 'Docker engine not reachable (docker info failed); start Docker Desktop';
    return null;
  }
  return `unknown broker kind ${kind}`;
}

const results = [];
for (const kind of kinds) {
  const missing = prerequisite(kind);
  if (missing) {
    results.push({ kind, ok: false, note: missing });
    continue;
  }
  console.log(`\n=== end-to-end on ${kind} ===`);
  const r = spawnSync(process.execPath, ['../../node_modules/vitest/vitest.mjs', 'run', 'test/e2e.test.ts'], {
    stdio: 'inherit',
    env: { ...process.env, VOLTAX_TEST_CLOUD_BROKER: kind },
  });
  results.push({ kind, ok: r.status === 0, note: r.status === 0 ? 'passed' : `vitest exit ${r.status}` });
}
console.log('\nbroker results:');
for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.kind}: ${r.note}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
