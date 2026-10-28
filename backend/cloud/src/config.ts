import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const optional = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

const schema = z
  .object({
    DATABASE_URL: z.string().min(1),
    // 32-byte key that seals TOTP secrets at rest. Generate with: openssl rand -hex 32. Never commit it.
    CLOUD_DATA_KEY: z.string().min(1),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    PUBLIC_ORIGIN: z.string().url().optional(),
    // Plain-HTTP local development only. Production runs behind Caddy with HTTPS.
    COOKIE_SECURE: bool.default(true),
    TRUST_PROXY: z.string().default(''),
    // Production applies migrations with `cli migrate` as the owner role; the app role cannot.
    MIGRATE_ON_START: bool.default(false),
    // What installers put into a hub's CLOUD_URL, e.g. mqtts://broker.voltex.example:8883
    BROKER_PUBLIC_URL: optional,
    // Ed25519 command-signing key (PEM). Public half is pinned on every hub.
    COMMAND_KEY_FILE: z.string().default('/run/secrets/cloud-command.key'),
    // Ed25519 audit checkpoint key (PEM). Kept apart from the database.
    AUDIT_KEY_FILE: z.string().default('/run/secrets/cloud-audit.key'),
    AUDIT_EXPORT_INTERVAL_MS: z.coerce.number().int().min(10_000).default(5 * 60_000),

    // The cloud's own connection to the cloud broker (EMQX) as the service account.
    CLOUD_BROKER_URL: optional,
    CLOUD_BROKER_PASSWORD: optional,
    CLOUD_BROKER_CA: optional,
    // Internal HTTP API that EMQX calls for authentication/authorisation. Private network only.
    INTERNAL_HOST: z.string().default('0.0.0.0'),
    INTERNAL_PORT: z.coerce.number().int().min(0).max(65535).default(0),
    BROKER_AUTH_SECRET: optional,

    // Owner email (any SMTP provider). Without it, email notices fail closed (control stays blocked).
    SMTP_URL: optional,
    SMTP_FROM: optional,
    // Web Push for staff browsers. Generate with: node dist/cli.js gen-vapid-keys
    VAPID_PUBLIC_KEY: optional,
    VAPID_PRIVATE_KEY: optional,
    VAPID_SUBJECT: optional,
    // Off-device audit copy (S3-compatible, bucket with Object Lock). Credential needs PutObject + GetObject only.
    S3_ENDPOINT: optional,
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: optional,
    S3_ACCESS_KEY_ID: optional,
    S3_SECRET_ACCESS_KEY: optional,
    S3_LOCK_DAYS: z.coerce.number().int().min(0).default(365),

    ADMIN_UI_DIR: z.string().default(''),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  })
  .superRefine((c, ctx) => {
    // Settings that only work together: name what is missing, never echo a value.
    const together = (names: Array<keyof typeof c>) => {
      const set = names.filter((n) => c[n] !== undefined);
      if (set.length > 0 && set.length < names.length) {
        for (const n of names.filter((x) => c[x] === undefined)) ctx.addIssue({ code: 'custom', path: [n], message: `required with ${set.join(', ')}` });
      }
    };
    together(['CLOUD_BROKER_URL', 'CLOUD_BROKER_PASSWORD']);
    together(['SMTP_URL', 'SMTP_FROM']);
    together(['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']);
    together(['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']);
    if (c.INTERNAL_PORT && (!c.BROKER_AUTH_SECRET || c.BROKER_AUTH_SECRET.length < 32)) {
      ctx.addIssue({ code: 'custom', path: ['BROKER_AUTH_SECRET'], message: 'at least 32 characters required when INTERNAL_PORT is set' });
    }
    if (c.INTERNAL_PORT && !c.CLOUD_BROKER_PASSWORD) {
      ctx.addIssue({ code: 'custom', path: ['CLOUD_BROKER_PASSWORD'], message: 'required when INTERNAL_PORT is set' });
    }
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
