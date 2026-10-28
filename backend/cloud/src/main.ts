import { existsSync, readFileSync } from 'node:fs';
import { createCloud } from './cloud.js';
import { SmtpEmail, WebPushSender } from './channels.js';
import { loadCloudConfig, type CloudConfig } from './config.js';
import { parseDataKey } from './crypto.js';
import { pgDb } from './db.js';
import { buildInternalApi } from './internal.js';
import { S3Store } from './s3.js';

const config = loadCloudConfig();
const readKey = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : undefined);
const commandKeyPem = readKey(config.COMMAND_KEY_FILE);
const auditKeyPem = readKey(config.AUDIT_KEY_FILE);
const releasePublicKey = readKey(config.RELEASE_PUBKEY_FILE);

/** Which optional parts are on (names only; values never reach the log). */
function features(c: CloudConfig) {
  return {
    commands: Boolean(commandKeyPem),
    auditCheckpoints: Boolean(auditKeyPem),
    releases: Boolean(releasePublicKey),
    broker: Boolean(c.CLOUD_BROKER_URL),
    brokerAuthApi: c.INTERNAL_PORT > 0,
    email: Boolean(c.SMTP_URL),
    push: Boolean(c.VAPID_PUBLIC_KEY),
    auditExport: Boolean(c.S3_ENDPOINT),
  };
}

const cloud = await createCloud({
  db: pgDb(config.DATABASE_URL),
  dataKey: parseDataKey(config.CLOUD_DATA_KEY),
  commandKeyPem,
  auditKeyPem,
  releasePublicKey,
  migrate: config.MIGRATE_ON_START,
  api: {
    cookieSecure: config.COOKIE_SECURE,
    publicOrigin: config.PUBLIC_ORIGIN,
    brokerUrl: config.BROKER_PUBLIC_URL,
    trustProxy: config.TRUST_PROXY || false,
  },
  server: { logger: { level: config.LOG_LEVEL } },
  broker: config.CLOUD_BROKER_URL ? { url: config.CLOUD_BROKER_URL, password: config.CLOUD_BROKER_PASSWORD!, caFile: config.CLOUD_BROKER_CA } : undefined,
  email: config.SMTP_URL ? new SmtpEmail({ url: config.SMTP_URL, from: config.SMTP_FROM! }) : null,
  push: config.VAPID_PUBLIC_KEY
    ? { sender: new WebPushSender({ subject: config.VAPID_SUBJECT!, publicKey: config.VAPID_PUBLIC_KEY, privateKey: config.VAPID_PRIVATE_KEY! }), publicKey: config.VAPID_PUBLIC_KEY }
    : null,
  objectStore: config.S3_ENDPOINT
    ? new S3Store({ endpoint: config.S3_ENDPOINT, region: config.S3_REGION, bucket: config.S3_BUCKET!, accessKeyId: config.S3_ACCESS_KEY_ID!, secretAccessKey: config.S3_SECRET_ACCESS_KEY!, lockDays: config.S3_LOCK_DAYS })
    : null,
  auditExportIntervalMs: config.AUDIT_EXPORT_INTERVAL_MS,
});
const log = cloud.app.log;
log.info({ features: features(config) }, 'cloud configured');
if (!commandKeyPem) log.warn(`no command key at ${config.COMMAND_KEY_FILE}: support actions to hubs are disabled`);
if (!auditKeyPem) log.warn(`no audit key at ${config.AUDIT_KEY_FILE}: audit checkpoints are not signed`);
if (!releasePublicKey) log.warn(`no release public key at ${config.RELEASE_PUBKEY_FILE}: no release can be registered`);
if (!config.SMTP_URL) log.warn('no SMTP_URL: owner email notices fail closed, so remote control stays blocked');

const internal =
  config.INTERNAL_PORT > 0 ? await buildInternalApi({ homes: cloud.homes, cloudServicePassword: config.CLOUD_BROKER_PASSWORD!, sharedSecret: config.BROKER_AUTH_SECRET! }) : null;
await internal?.listen({ host: config.INTERNAL_HOST, port: config.INTERNAL_PORT });
await cloud.app.listen({ host: config.HOST, port: config.PORT });
await cloud.start();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    log.info({ signal }, 'shutting down');
    void Promise.all([internal?.close(), cloud.close()]).then(() => process.exit(0));
  });
}
