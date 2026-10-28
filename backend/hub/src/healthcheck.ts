// Container health check: exit 0 when the local API answers and the DB is up.
// MQTT being down is "degraded" but healthy: the hub reconnects on its own, a restart would not help.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { hubTlsName } from './config.js';

const env = process.env;
const port = Number(env.PORT ?? 8443);
const insecure = env.ALLOW_INSECURE_HTTP === 'true';
const hubId = env.HUB_ID ?? '';

const options = {
  host: '127.0.0.1',
  port,
  path: '/api/v1/health',
  timeout: 4000,
  // Full certificate validation against the hub CA, using the real TLS name (not 127.0.0.1).
  ...(insecure ? {} : { ca: readFileSync(env.TLS_CA ?? '/etc/voltax/tls/ca.crt'), servername: hubTlsName(hubId) }),
};

const req = (insecure ? http : https).get(options, (res) => {
  let body = '';
  res.on('data', (c: Buffer) => (body += c.toString()));
  res.on('end', () => {
    try {
      const health = JSON.parse(body) as { db?: string };
      process.exit(res.statusCode === 200 && health.db === 'up' ? 0 : 1);
    } catch {
      process.exit(1);
    }
  });
});
req.on('timeout', () => req.destroy(new Error('timeout')));
req.on('error', () => process.exit(1));
