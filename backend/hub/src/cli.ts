// Installer CLI, run inside the hub container (see deploy/pi/voltax-hubctl):
//   pairing-code [--role owner|member]   print a one-time pairing code (stdout only, never logged)
//   clients                              list paired clients
//   revoke <clientId> [--force]          revoke a client (--force allows the last owner)
//   remove-device <deviceId>             forget a device (its MQTT credential is removed by remove-device.sh)
import { Auth } from './auth.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { Store } from './store.js';

const [command, ...args] = process.argv.slice(2);
const config = loadConfig({ MQTT_PASSWORD: 'unused-by-cli', ...process.env });
const db = openDb(config.DB_PATH, { backupDir: config.BACKUP_DIR });
const auth = new Auth(db);

function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

try {
  switch (command) {
    case 'pairing-code': {
      const role = flag('--role') ?? 'owner';
      if (role !== 'owner' && role !== 'member') throw new Error('--role must be owner or member');
      const { code, expiresAt } = auth.createPairingCode(role);
      const pretty = `${code.slice(0, 5)}-${code.slice(5)}`;
      // Machine-readable last line so voltax-hubctl can render it as a QR code.
      process.stdout.write(
        `Pairing code (${role}, single use, expires ${new Date(expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })}): ${pretty}\n` +
          `voltax://pair?hub=${encodeURIComponent(config.HUB_ID)}&code=${code}\n`,
      );
      break;
    }
    case 'clients':
      for (const c of auth.listClients()) {
        process.stdout.write(`${c.clientId}  ${c.role.padEnd(6)}  ${c.revokedAt ? 'REVOKED' : 'active '}  ${c.name}\n`);
      }
      break;
    case 'revoke': {
      const id = args[0];
      if (!id) throw new Error('usage: revoke <clientId> [--force]');
      const r = auth.revoke(id, { allowLastOwner: args.includes('--force') });
      if (r !== 'ok') throw new Error(r === 'last_owner' ? 'refusing to revoke the last owner (use --force)' : 'client not found');
      process.stdout.write(`revoked ${id}\n`);
      break;
    }
    case 'remove-device': {
      const id = args[0];
      if (!id) throw new Error('usage: remove-device <deviceId>');
      if (!new Store(db).deleteDevice(id)) throw new Error('device not found');
      process.stdout.write(`removed ${id} from the hub database\n`);
      break;
    }
    default:
      throw new Error('usage: cli.js pairing-code [--role owner|member] | clients | revoke <clientId> [--force] | remove-device <deviceId>');
  }
} catch (err) {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exitCode = 1;
} finally {
  db.close();
}
