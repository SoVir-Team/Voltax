// Shared helpers for the load test (docs/testing/load-test-spec.md).
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Imports a built module of this repo (npm run build first). */
export const load = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
export const between = (min, max) => min + Math.random() * (max - min);

export async function until(check, what, timeoutMs = 60_000, everyMs = 500) {
  const start = Date.now();
  for (;;) {
    const v = await check().catch(() => undefined);
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

export const freePort = () =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

export const docker = (args) => spawnSync('docker', args, { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });

/** Exact percentile (nearest rank) of a numeric array. */
export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

export function summarise(values) {
  const s = Float64Array.from(values).sort();
  const round = (v) => (v === null ? null : Math.round(v * 10) / 10);
  return { count: s.length, p50: round(percentile(s, 50)), p95: round(percentile(s, 95)), p99: round(percentile(s, 99)), max: round(s.length ? s[s.length - 1] : null) };
}

// EMQX with the cloud's internal auth API: the same configuration as backend/cloud/test/broker-helper.ts
// (emqxConfig), which `npm run test:brokers` exercises.
export const EMQX_IMAGE = process.env.VOLTAX_TEST_EMQX_IMAGE ?? 'emqx/emqx:5.8.6';
export const MAILPIT_IMAGE = process.env.VOLTAX_TEST_MAILPIT_IMAGE ?? 'axllent/mailpit:v1.27';

export function emqxConfig(internalUrl, sharedSecret) {
  const headers = `headers { "content-type" = "application/json", "x-voltax-broker-secret" = "${sharedSecret}" }`;
  return [
    `node { name = "emqx@127.0.0.1", cookie = "${randomBytes(16).toString('hex')}", data_dir = "data" }`,
    'cluster { name = voltaxload, discovery_strategy = manual }',
    'dashboard { listeners.http.bind = 0 }',
    'listeners.tcp.default { bind = "0.0.0.0:1883", max_connections = 10000 }',
    'listeners.ssl.default { enable = false }',
    'listeners.ws.default { enable = false }',
    'listeners.wss.default { enable = false }',
    'authentication = [{',
    '  mechanism = password_based, backend = http, enable = true, method = post',
    `  url = "${internalUrl}/broker/authn"`,
    `  ${headers}`,
    '  body { username = "${username}", password = "${password}" }',
    '  request_timeout = "5s"',
    '}]',
    'authorization {',
    '  no_match = deny',
    '  deny_action = ignore',
    '  cache { enable = false }',
    '  sources = [{',
    '    type = http, enable = true, method = post',
    `    url = "${internalUrl}/broker/authz"`,
    `    ${headers}`,
    '    body { username = "${username}", topic = "${topic}", action = "${action}" }',
    '    request_timeout = "5s"',
    '  }]',
    '}',
    '',
  ].join('\n');
}
