// Server-side administration. Runs on the cloud host only (no network endpoint does any of this):
//   node dist/cli.js migrate                         (as the database OWNER role)
//   node dist/cli.js bootstrap-admin --email ops@voltex.example --name "Ops Lead"
//   node dist/cli.js audit-verify                    chain + signed checkpoints (needs AUDIT_KEY_FILE or --pubkey)
//   node dist/cli.js audit-export                    export now to the S3 bucket
//   node dist/cli.js audit-bucket-create             create the S3 bucket with Object Lock (once)
//   node dist/cli.js verify-export --file <object.jsonl> --pubkey <cloud-audit.key.pub> [--prev <hash>]
//                                                    offline check of an exported copy (no database)
//   node dist/cli.js gen-data-key
//   node dist/cli.js gen-command-key --out /etc/voltax-cloud/cloud-command.key
//   node dist/cli.js gen-audit-key --out /etc/voltax-cloud/cloud-audit.key
//   node dist/cli.js gen-vapid-keys
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import webpush from 'web-push';
import { CloudAudit } from './audit.js';
import { AuditExport, verifyExportedObject } from './audit-export.js';
import { AuditCheckpoints, checkpointSignatureValid } from './checkpoints.js';
import { loadCloudConfig } from './config.js';
import { parseDataKey } from './crypto.js';
import { migrate, pgDb } from './db.js';
import { S3Store } from './s3.js';
import { EnvelopeSigner } from './signer.js';
import { StaffService } from './staff.js';

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: { email: { type: 'string' }, name: { type: 'string' }, out: { type: 'string' }, file: { type: 'string' }, pubkey: { type: 'string' }, prev: { type: 'string' } },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function genSigningKey(out: string | undefined, installHint: string): void {
  if (!out) fail(`usage: ${command} --out <path to private key>`);
  if (existsSync(out)) fail(`${out} exists; refusing to overwrite a signing key`);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  writeFileSync(`${out}.pub`, publicKey.export({ type: 'spki', format: 'pem' }).toString(), { mode: 0o644, flag: 'wx' });
  console.log(`private key: ${out} (keep secret)\npublic key:  ${out}.pub (${installHint})`);
}

const publicFrom = (pem: string) => createPublicKey(createPrivateKey(pem)).export({ type: 'spki', format: 'pem' }).toString();

switch (command) {
  case 'gen-data-key':
    // Printed once for the operator to put into the cloud env file (never into git).
    console.log(randomBytes(32).toString('hex'));
    break;

  case 'gen-command-key':
    genSigningKey(values.out, 'install on hubs as /etc/voltax/cloud/cloud-command.pub');
    break;

  case 'gen-audit-key':
    genSigningKey(values.out, 'give to auditors; verifies checkpoints in exported copies');
    break;

  case 'gen-vapid-keys': {
    const keys = webpush.generateVAPIDKeys();
    console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}\n# put both into the cloud env file (never into git)`);
    break;
  }

  case 'verify-export': {
    if (!values.file || !values.pubkey) fail('usage: verify-export --file <object.jsonl> --pubkey <public key pem> [--prev <hash of the record before>]');
    const result = verifyExportedObject(readFileSync(values.file, 'utf8'), values.prev);
    const signed = result.checkpoint ? checkpointSignatureValid(result.checkpoint, readFileSync(values.pubkey, 'utf8')) : false;
    console.log(JSON.stringify({ ...result, checkpointSignatureValid: signed }));
    if (!result.ok || !signed) process.exitCode = 2;
    break;
  }

  default: {
    const config = loadCloudConfig();
    const db = pgDb(config.DATABASE_URL, 2);
    try {
      if (command === 'migrate') {
        await migrate(db);
        console.log('migrations applied');
        break;
      }
      const audit = new CloudAudit(db);
      const auditKeyPem = existsSync(config.AUDIT_KEY_FILE) ? readFileSync(config.AUDIT_KEY_FILE, 'utf8') : null;
      const checkpoints = new AuditCheckpoints(db, audit, auditKeyPem ? new EnvelopeSigner(auditKeyPem) : null);
      const s3 = config.S3_ENDPOINT
        ? new S3Store({ endpoint: config.S3_ENDPOINT, region: config.S3_REGION, bucket: config.S3_BUCKET!, accessKeyId: config.S3_ACCESS_KEY_ID!, secretAccessKey: config.S3_SECRET_ACCESS_KEY!, lockDays: config.S3_LOCK_DAYS })
        : null;
      if (command === 'bootstrap-admin') {
        if (!values.email || !values.name) fail('usage: bootstrap-admin --email <email> --name <display name>');
        const staff = new StaffService(db, audit, parseDataKey(config.CLOUD_DATA_KEY));
        const { setupToken } = await staff.bootstrapAdmin(values.email, values.name);
        console.log('Super admin created. Give this one-time setup link to them over a trusted channel (valid 24 hours):');
        console.log(`${config.PUBLIC_ORIGIN ?? '<portal>'}/setup#${setupToken}`);
      } else if (command === 'audit-verify') {
        const pub = values.pubkey ? readFileSync(values.pubkey, 'utf8') : auditKeyPem ? publicFrom(auditKeyPem) : null;
        const result = await checkpoints.verify(pub);
        console.log(JSON.stringify(result));
        if (!result.ok) process.exitCode = 2;
      } else if (command === 'audit-export') {
        if (!s3) fail('S3_ENDPOINT is not configured');
        console.log(`exported ${await new AuditExport(db, audit, checkpoints, s3).runAll()} records`);
      } else if (command === 'audit-bucket-create') {
        if (!s3) fail('S3_ENDPOINT is not configured');
        await s3.createBucket();
        console.log(`bucket ${config.S3_BUCKET} created with Object Lock`);
      } else {
        fail('commands: migrate | bootstrap-admin | audit-verify | audit-export | audit-bucket-create | verify-export | gen-data-key | gen-command-key | gen-audit-key | gen-vapid-keys');
      }
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      await db.close();
    }
  }
}
