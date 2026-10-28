import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Role } from '@voltax/contracts';
import type { DB } from './db.js';

// Crockford base32 without I, L, O, U: easy to read aloud and type.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 10; // 10 x 5 bits = 50 bits of entropy

export const OWNER_CODE_TTL_MS = 10 * 60 * 1000;
export const MEMBER_CODE_TTL_MS = 5 * 60 * 1000;
const IP_WINDOW_MS = 15 * 60 * 1000;
const IP_MAX_FAILURES = 5;
const GLOBAL_MAX_FAILURES = 10;

export interface Client {
  clientId: string;
  name: string;
  role: Role;
  createdAt: number;
  revokedAt: number | null;
}

/** '*' = every device, otherwise the device ids a member may see and control. */
export type DeviceGrant = '*' | string[];

/** What a client may reach: owners and '*' members get 'all'. */
export type DeviceScope = 'all' | ReadonlySet<string>;

export type PairResult =
  | { ok: true; clientId: string; token: string; role: Role }
  | { ok: false; status: 401 | 429; error: string };

interface ClientRow {
  client_id: string;
  name: string;
  role: Role;
  created_at: number;
  revoked_at: number | null;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/** Pairing codes and client tokens. Only SHA-256 hashes are stored; secrets are never logged. */
export class Auth {
  private ipFailures = new Map<string, number[]>();
  private revokeListeners = new Set<(clientId: string) => void>();

  constructor(private db: DB) {}

  /** Deliberate action (installer CLI or owner). Opening a code also resets the failure counter. */
  createPairingCode(
    role: Role,
    ttlMs = role === 'owner' ? OWNER_CODE_TTL_MS : MEMBER_CODE_TTL_MS,
    devices: DeviceGrant = '*',
  ): { code: string; expiresAt: number } {
    const bytes = randomBytes(CODE_LENGTH);
    const code = Array.from(bytes, (b) => ALPHABET[b % 32]).join(''); // 256 % 32 === 0, so unbiased
    const expiresAt = Date.now() + ttlMs;
    const scope = role === 'member' ? JSON.stringify(devices) : null;
    this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO pairing_codes (code_hash, role, expires_at, device_scope) VALUES (?, ?, ?, ?)')
        .run(sha256(code), role, expiresAt, scope);
      this.setFailures(0);
    })();
    return { code, expiresAt };
  }

  pair(rawCode: string, clientName: string, ip: string): PairResult {
    const now = Date.now();
    const recent = (this.ipFailures.get(ip) ?? []).filter((t) => now - t < IP_WINDOW_MS);
    this.ipFailures.set(ip, recent);
    if (recent.length >= IP_MAX_FAILURES) return { ok: false, status: 429, error: 'too many attempts, try later' };

    const hash = sha256(normalizeCode(rawCode));
    const result = this.db.transaction((): PairResult | null => {
      const row = this.db
        .prepare('SELECT role, device_scope FROM pairing_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?')
        .get(hash, now) as { role: Role; device_scope: string | null } | undefined;
      if (!row) return null;
      // Single use: the conditional UPDATE makes concurrent redemptions impossible.
      const used = this.db.prepare('UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL').run(now, hash);
      if (used.changes !== 1) return null;
      const clientId = randomUUID();
      const token = randomBytes(32).toString('base64url');
      this.db
        .prepare('INSERT INTO clients (client_id, name, role, token_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(clientId, clientName, row.role, sha256(token), now);
      if (row.role === 'member') this.writeDevices(clientId, row.device_scope ? (JSON.parse(row.device_scope) as DeviceGrant) : '*');
      return { ok: true, clientId, token, role: row.role };
    })();
    if (result) return result;

    recent.push(now);
    const total = this.failures() + 1;
    if (total >= GLOBAL_MAX_FAILURES) {
      // Too many guesses overall: close the pairing window until someone deliberately opens a new code.
      this.db.transaction(() => {
        this.db.prepare('UPDATE pairing_codes SET used_at = ? WHERE used_at IS NULL').run(now);
        this.setFailures(0);
      })();
    } else {
      this.setFailures(total);
    }
    return { ok: false, status: 401, error: 'invalid or expired pairing code' };
  }

  authenticate(token: string | undefined): Client | null {
    if (!token) return null;
    const row = this.db
      .prepare('SELECT * FROM clients WHERE token_hash = ? AND revoked_at IS NULL')
      .get(sha256(token)) as ClientRow | undefined;
    return row ? toClient(row) : null;
  }

  /** Devices a client may see and control. Read on every request, so changes apply immediately. */
  deviceScope(client: Pick<Client, 'clientId' | 'role'>): DeviceScope {
    if (client.role === 'owner') return 'all';
    const ids = (this.db.prepare('SELECT device_id FROM client_devices WHERE client_id = ?').all(client.clientId) as Array<{ device_id: string }>).map(
      (r) => r.device_id,
    );
    return ids.includes('*') ? 'all' : new Set(ids);
  }

  memberDevices(clientId: string): DeviceGrant {
    const scope = this.deviceScope({ clientId, role: 'member' });
    return scope === 'all' ? '*' : [...scope].sort();
  }

  setMemberDevices(clientId: string, devices: DeviceGrant): 'ok' | 'not_found' | 'not_member' {
    const row = this.db.prepare('SELECT role FROM clients WHERE client_id = ? AND revoked_at IS NULL').get(clientId) as { role: Role } | undefined;
    if (!row) return 'not_found';
    if (row.role !== 'member') return 'not_member';
    this.db.transaction(() => this.writeDevices(clientId, devices))();
    return 'ok';
  }

  listClients(): Client[] {
    return (this.db.prepare('SELECT * FROM clients ORDER BY created_at').all() as ClientRow[]).map(toClient);
  }

  revoke(clientId: string, opts: { allowLastOwner?: boolean } = {}): 'ok' | 'not_found' | 'last_owner' {
    const row = this.db.prepare('SELECT * FROM clients WHERE client_id = ? AND revoked_at IS NULL').get(clientId) as ClientRow | undefined;
    if (!row) return 'not_found';
    if (row.role === 'owner' && !opts.allowLastOwner) {
      const owners = this.db.prepare("SELECT COUNT(*) AS n FROM clients WHERE role = 'owner' AND revoked_at IS NULL").get() as { n: number };
      if (owners.n <= 1) return 'last_owner';
    }
    this.db.prepare('UPDATE clients SET revoked_at = ? WHERE client_id = ?').run(Date.now(), clientId);
    for (const listener of this.revokeListeners) listener(clientId);
    return 'ok';
  }

  onRevoke(listener: (clientId: string) => void): () => void {
    this.revokeListeners.add(listener);
    return () => this.revokeListeners.delete(listener);
  }

  pruneCodes(): void {
    this.db.prepare('DELETE FROM pairing_codes WHERE expires_at < ?').run(Date.now() - 24 * 60 * 60 * 1000);
  }

  private writeDevices(clientId: string, devices: DeviceGrant): void {
    this.db.prepare('DELETE FROM client_devices WHERE client_id = ?').run(clientId);
    const insert = this.db.prepare('INSERT OR IGNORE INTO client_devices (client_id, device_id) VALUES (?, ?)');
    for (const id of devices === '*' ? ['*'] : devices) insert.run(clientId, id);
  }

  private failures(): number {
    const row = this.db.prepare("SELECT value FROM hub_meta WHERE key = 'pairing_failures'").get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  private setFailures(n: number): void {
    this.db.prepare("INSERT INTO hub_meta (key, value) VALUES ('pairing_failures', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(n));
  }
}

function toClient(r: ClientRow): Client {
  return { clientId: r.client_id, name: r.name, role: r.role, createdAt: r.created_at, revokedAt: r.revoked_at };
}
