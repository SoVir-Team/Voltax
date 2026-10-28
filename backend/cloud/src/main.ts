import { createPrivateKey, createPublicKey } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createCloud } from './cloud.js';
import { loadCloudConfig } from './config.js';
import { parseDataKey } from './crypto.js';
import { pgDb } from './db.js';

const config = loadCloudConfig();
const commandKeyPem = existsSync(config.COMMAND_KEY_FILE) ? readFileSync(config.COMMAND_KEY_FILE, 'utf8') : undefined;

const cloud = await createCloud({
  db: pgDb(config.DATABASE_URL),
  dataKey: parseDataKey(config.CLOUD_DATA_KEY),
  commandKeyPem,
  api: {
    cookieSecure: config.COOKIE_SECURE,
    publicOrigin: config.PUBLIC_ORIGIN,
    brokerUrl: config.BROKER_PUBLIC_URL,
    trustProxy: config.TRUST_PROXY || false,
    commandPublicKeyPem: commandKeyPem
      ? createPublicKey(createPrivateKey(commandKeyPem)).export({ type: 'spki', format: 'pem' }).toString()
      : undefined,
  },
  server: { logger: { level: config.LOG_LEVEL } },
});
if (!commandKeyPem) cloud.app.log.warn(`no command key at ${config.COMMAND_KEY_FILE}: support commands to hubs are disabled`);

await cloud.app.listen({ host: config.HOST, port: config.PORT });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    cloud.app.log.info({ signal }, 'shutting down');
    void cloud.close().then(() => process.exit(0));
  });
}
