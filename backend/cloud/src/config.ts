import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  // 32-byte key that seals TOTP secrets at rest. Generate with: openssl rand -hex 32. Never commit it.
  CLOUD_DATA_KEY: z.string().min(1),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  PUBLIC_ORIGIN: z.string().url().optional(),
  // Plain-HTTP local development only. Production runs behind Caddy with HTTPS.
  COOKIE_SECURE: bool.default(true),
  TRUST_PROXY: z.string().default(''),
  // What installers put into a hub's CLOUD_URL, e.g. mqtts://broker.voltex.example:8883
  BROKER_PUBLIC_URL: z.string().optional(),
  // Ed25519 command-signing key (PEM). Public half is pinned on every hub.
  COMMAND_KEY_FILE: z.string().default('/run/secrets/cloud-command.key'),
  ADMIN_UI_DIR: z.string().default(''),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type CloudConfig = z.infer<typeof schema>;

export function loadCloudConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid cloud configuration: ${issues}`);
  }
  return parsed.data;
}
