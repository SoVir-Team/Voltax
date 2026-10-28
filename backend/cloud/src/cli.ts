// Server-side administration. Runs on the cloud host only (no network endpoint does any of this):
//   node dist/cli.js migrate
//   node dist/cli.js bootstrap-admin --email ops@voltex.example --name "Ops Lead"
//   node dist/cli.js audit-verify
//   node dist/cli.js gen-command-key --out /etc/voltax-cloud/cloud-command.key
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { CloudAudit } from './audit.js';
import { loadCloudConfig } from './config.js';
import { parseDataKey } from './crypto.js';
import { migrate, pgDb } from './db.js';
import { StaffService } from './staff.js';

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: { email: { type: 'string' }, name: { type: 'string' }, out: { type: 'string' } },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

switch (command) {
  case 'gen-data-key':
    // Printed once for the operator to put into the cloud env file (never into git).
    console.log(randomBytes(32).toString('hex'));
    break;

  case 'gen-command-key': {
    if (!values.out) fail('usage: gen-command-key --out <path to private key>');
    if (existsSync(values.out)) fail(`${values.out} exists; refusing to overwrite a signing key`);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    writeFileSync(values.out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    writeFileSync(`${values.out}.pub`, pub, { mode: 0o644, flag: 'wx' });
    console.log(`private key: ${values.out} (keep secret)\npublic key:  ${values.out}.pub (install on hubs as /etc/voltax/cloud/cloud-command.pub)`);
    break;
  }

  default: {
    const config = loadCloudConfig();
    const db = pgDb(config.DATABASE_URL, 2);
    try {
      await migrate(db);
      const audit = new CloudAudit(db);
      if (command === 'migrate') {
        console.log('migrations applied');
      } else if (command === 'bootstrap-admin') {
        if (!values.email || !values.name) fail('usage: bootstrap-admin --email <email> --name <display name>');
        const staff = new StaffService(db, audit, parseDataKey(config.CLOUD_DATA_KEY));
        const { setupToken } = await staff.bootstrapAdmin(values.email, values.name);
        console.log('Super admin created. Give this one-time setup link to them over a trusted channel (valid 24 hours):');
        console.log(`${config.PUBLIC_ORIGIN ?? '<portal>'}/setup#${setupToken}`);
      } else if (command === 'audit-verify') {
        const result = await audit.verify();
        console.log(JSON.stringify(result));
        if (!result.ok) process.exitCode = 2;
      } else {
        fail('commands: migrate | bootstrap-admin | audit-verify | gen-data-key | gen-command-key');
      }
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      await db.close();
    }
  }
}
