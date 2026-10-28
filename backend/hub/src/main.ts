import { existsSync, readFileSync } from 'node:fs';
import { loadConfig } from './config.js';
import { createHub } from './hub.js';

const config = loadConfig();

const https = config.ALLOW_INSECURE_HTTP
  ? null
  : { key: readFileSync(config.TLS_KEY), cert: readFileSync(config.TLS_CERT), minVersion: 'TLSv1.2' as const };

const cloudKey = existsSync(config.CLOUD_COMMAND_PUBKEY) ? readFileSync(config.CLOUD_COMMAND_PUBKEY, 'utf8') : null;

const hub = await createHub({ ...config, CLOUD_COMMAND_PUBKEY_PEM: cloudKey }, {
  logger: { level: config.LOG_LEVEL, redact: ['req.headers.authorization'] },
  ...(https ? { https } : {}),
});

if (!https) hub.app.log.warn('ALLOW_INSECURE_HTTP=true: serving plain HTTP. Development only.');

await hub.start();
await hub.app.listen({ host: config.HOST, port: config.PORT });

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    hub.app.log.info({ signal }, 'shutting down');
    hub
      .stop()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
}
