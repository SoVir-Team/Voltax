import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z.object({
  HUB_ID: z.string().regex(/^[a-z0-9-]{3,40}$/, 'lowercase letters, digits and dashes'),
  HUB_NAME: z.string().default('Voltax Hub'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8443),
  DB_PATH: z.string().default('/var/lib/voltax/hub/hub.db'),
  BACKUP_DIR: z.string().default('/var/lib/voltax/backups'),
  MQTT_URL: z.string().default('mqtt://127.0.0.1:1883'),
  MQTT_USERNAME: z.string().default('hub'),
  MQTT_PASSWORD: z.string().min(1),
  TLS_CERT: z.string().default('/etc/voltax/tls/hub.crt'),
  TLS_KEY: z.string().default('/etc/voltax/tls/hub.key'),
  TLS_CA: z.string().default('/etc/voltax/tls/ca.crt'),
  // Development only: serve plain HTTP. Never set on a real hub.
  ALLOW_INSECURE_HTTP: bool.default(false),
  UI_DIR: z.string().default('/app/public'),
  TIME_SYNC_FILE: z.string().default('/run/systemd/timesync/synchronized'),
  // Optional cloud link (remote support, fleet). Empty CLOUD_URL = fully local hub, nothing changes.
  CLOUD_URL: z.string().default(''),
  CLOUD_PASSWORD: z.string().default(''),
  CLOUD_CA: z.string().default('/etc/voltax/cloud/ca.crt'),
  // Pinned Ed25519 public key of the VOLTEX cloud command signer (PEM). Missing = cloud requests refused.
  CLOUD_COMMAND_PUBKEY: z.string().default('/etc/voltax/cloud/cloud-command.pub'),
  TELEMETRY_INTERVAL_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(60_000),
  // Hand-off folder to the root updater on the host (see deploy/pi/scripts/voltax-update-request.sh).
  UPDATE_DIR: z.string().default('/var/lib/voltax/update-request'),
  // Contact sent to browser push services with each notification (VAPID). Use the home's or installer's.
  PUSH_SUBJECT: z.string().regex(/^(mailto:|https:)/).default('mailto:owner@voltex-hub.local'),
  TZ: z.string().default('Asia/Kolkata'),
  VOLTAX_VERSION: z.string().default('dev'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid hub configuration: ${issues}`);
  }
  return parsed.data;
}

/** TLS hostname every client validates against (see docs/architecture.md, local TLS). */
export function hubTlsName(hubId: string): string {
  return `${hubId}.hub.voltax.internal`;
}
