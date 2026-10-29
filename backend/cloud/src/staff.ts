import { randomUUID } from 'node:crypto';
import type { PlatformRole, StaffView } from '@voltax/contracts';
import type { CloudAudit } from './audit.js';
import { hashPassword, newToken, sha256, verifyPassword, type ScryptCost } from './crypto.js';
import type { Db } from './db.js';
import { CloudError, conflict, forbidden, notFound } from './errors.js';

export const SESSION_TTL_MS = 8 * 60 * 60_000;
export const SESSION_IDLE_MS = 60 * 60_000;
export const SETUP_TOKEN_TTL_MS = 24 * 60 * 60_000;
export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MS = 15 * 60_000;
const TOUCH_INTERVAL_MS = 60_000;

export interface StaffRow {
  id: string;
  email: string;
  display_name: string;
  role: PlatformRole;
  password_hash: string | null;
  totp_secret: string | null;
  totp_pending: string | null;
  totp_last_step: number | null;
  failed_logins: number;
  locked_until: number | null;
  disabled_at: number | null;
  created_at: number;
}

export interface Session {
  tokenHash: string;
  staffId: string;
  mfa: boolean;
  createdAt: number;
  expiresAt: number;
}

export interface Authenticated {
  session: Session;
  staff: StaffRow;
}

// Same work for unknown accounts so response time does not reveal which emails exist.
let dummyHash: Promise<string> | null = null;

export class StaffService {
  constructor(
    private db: Db,
    private audit: CloudAudit,
    _dataKey: Buffer,
    private scryptCost?: ScryptCost,
  ) {}

  async create(input: { email: string; displayName: string; role: PlatformRole }, by: string): Promise<{ staff: StaffView; setupToken: string }> {
    const email = input.email.trim().toLowerCase();
    const id = randomUUID();
    const [existing] = await this.db.query('SELECT 1 FROM staff WHERE email = $1', [email]);
    if (existing) throw conflict('a staff account with this email already exists');
    await this.db.query('INSERT INTO staff (id, email, display_name, role, created_at, created_by) VALUES ($1, $2, $3, $4, $5, $6)', [
      id,
      email,
      input.displayName.trim(),
      input.role,
      Date.now(),
      by === 'cli' ? null : by,
    ]);
    const setupToken = await this.issueSetupToken(id);
    await this.audit.append({ actor: actorOf(by), action: 'staff.create', outcome: 'ok', target: `staff:${id}`, details: { role: input.role } });
    return { staff: view((await this.row(id))!), setupToken };
  }

  /**
   * First super admin, from the server CLI only. Refused once any enabled super admin exists, so it
   * can never be used as a backdoor into a running platform.
   */
  async bootstrapAdmin(email: string, displayName: string): Promise<{ staff: StaffView; setupToken: string }> {
    const [admin] = await this.db.query("SELECT 1 FROM staff WHERE role = 'PLATFORM_SUPER_ADMIN' AND disabled_at IS NULL");
    if (admin) {
      await this.audit.append({ actor: 'cli', action: 'staff.bootstrap', outcome: 'denied', details: { reason: 'super admin exists' } });
      throw conflict('a super admin already exists; use the portal to add staff');
    }
    return this.create({ email, displayName, role: 'PLATFORM_SUPER_ADMIN' }, 'cli');
  }

  /** One-time setup link: sets the password and signs the staff member in. */
  async completeSetup(token: string, password: string): Promise<{ token: string; staff: StaffView }> {
    const hash = sha256(token);
    const now = Date.now();
    const staffId = await this.db.tx(async (t) => {
      const [row] = await t.query<{ staff_id: string }>(
        'UPDATE staff_setup_tokens SET used_at = $2 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2 RETURNING staff_id',
        [hash, now],
      );
      if (!row) return null;
      const passwordHash = await hashPassword(password, this.scryptCost);
      await t.query(
        'UPDATE staff SET password_hash = $2, totp_secret = NULL, totp_pending = NULL, failed_logins = 0, locked_until = NULL WHERE id = $1 AND disabled_at IS NULL',
        [row.staff_id, passwordHash],
      );
      await t.query('UPDATE sessions SET revoked_at = $2 WHERE staff_id = $1 AND revoked_at IS NULL', [row.staff_id, now]);
      return row.staff_id;
    });
    const staff = staffId ? await this.row(staffId) : null;
    if (!staff || staff.disabled_at) {
      await this.audit.append({ actor: 'anonymous', action: 'staff.setup', outcome: 'denied', details: { reason: 'invalid or used setup link' } });
      throw new CloudError(400, 'invalid_setup', 'this setup link is invalid, expired or already used');
    }
    await this.audit.append({ actor: `staff:${staff.id}`, action: 'staff.setup', outcome: 'ok', target: `staff:${staff.id}` });
    return { token: await this.newSession(staff.id), staff: view(staff) };
  }

  async login(emailInput: string, password: string, ip: string): Promise<{ token: string; staff: StaffView }> {
    const email = emailInput.trim().toLowerCase();
    const [staff] = await this.db.query<StaffRow>('SELECT * FROM staff WHERE email = $1', [email]);
    const now = Date.now();
    const fail = async (reason: string, status = 401, message = 'email or password is incorrect') => {
      await this.audit.append({ actor: `ip:${ip}`, action: 'auth.login', outcome: 'denied', target: staff ? `staff:${staff.id}` : null, details: { reason } });
      throw new CloudError(status, 'login_failed', message);
    };

    if (!staff || !staff.password_hash) {
      dummyHash ??= hashPassword('voltax-timing-equaliser', this.scryptCost);
      await verifyPassword(password, await dummyHash);
      return fail(staff ? 'setup not complete' : 'unknown account');
    }
    if (staff.disabled_at) {
      await verifyPassword(password, staff.password_hash);
      return fail('account disabled');
    }
    if (staff.locked_until && staff.locked_until > now) return fail('account locked', 429, 'too many failed attempts, try again later');

    const passwordOk = await verifyPassword(password, staff.password_hash);
    if (!passwordOk) {
      const failures = staff.failed_logins + 1;
      const lock = failures >= MAX_FAILED_LOGINS ? now + LOCKOUT_MS : null;
      await this.db.query('UPDATE staff SET failed_logins = $2, locked_until = $3 WHERE id = $1', [staff.id, lock ? 0 : failures, lock]);
      return fail('bad password');
    }
    await this.db.query('UPDATE staff SET failed_logins = 0, locked_until = NULL WHERE id = $1', [staff.id]);
    const token = await this.newSession(staff.id);
    await this.audit.append({ actor: `staff:${staff.id}`, action: 'auth.login', outcome: 'ok', details: { ip } });
    return { token, staff: view(staff) };
  }

  /** Role, disabled flag and session state are read fresh on every request. */
  async authenticate(token: string | undefined): Promise<Authenticated | null> {
    if (!token || token.length > 128) return null;
    const hash = sha256(token);
    const now = Date.now();
    const [row] = await this.db.query<StaffRow & { s_mfa: boolean; s_created: number; s_expires: number; s_seen: number; s_revoked: number | null }>(
      `SELECT staff.*, s.mfa AS s_mfa, s.created_at AS s_created, s.expires_at AS s_expires, s.last_seen_at AS s_seen, s.revoked_at AS s_revoked
       FROM sessions s JOIN staff ON staff.id = s.staff_id WHERE s.token_hash = $1`,
      [hash],
    );
    if (!row || !row.password_hash || row.s_revoked || row.s_expires <= now || now - row.s_seen > SESSION_IDLE_MS || row.disabled_at) return null;
    if (now - row.s_seen > TOUCH_INTERVAL_MS) await this.db.query('UPDATE sessions SET last_seen_at = $2 WHERE token_hash = $1', [hash, now]);
    return {
      session: { tokenHash: hash, staffId: row.id, mfa: row.s_mfa, createdAt: row.s_created, expiresAt: row.s_expires },
      staff: row,
    };
  }

  /** Retention: deletes sessions that can no longer be used and setup links that are used or expired. */
  async purgeExpired(now = Date.now()): Promise<{ sessions: number; setupTokens: number }> {
    const sessions = await this.db.query('DELETE FROM sessions WHERE revoked_at IS NOT NULL OR expires_at <= $1 OR last_seen_at <= $2 RETURNING 1', [now, now - SESSION_IDLE_MS]);
    const tokens = await this.db.query('DELETE FROM staff_setup_tokens WHERE used_at IS NOT NULL OR expires_at <= $1 RETURNING 1', [now]);
    return { sessions: sessions.length, setupTokens: tokens.length };
  }

  async logout(session: Session): Promise<void> {
    await this.db.query('UPDATE sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL', [session.tokenHash, Date.now()]);
    await this.audit.append({ actor: `staff:${session.staffId}`, action: 'auth.logout', outcome: 'ok' });
  }

  async changePassword(auth: Authenticated, current: string, next: string): Promise<void> {
    if (!auth.staff.password_hash || !(await verifyPassword(current, auth.staff.password_hash))) {
      await this.audit.append({ actor: `staff:${auth.staff.id}`, action: 'auth.password.change', outcome: 'denied' });
      throw new CloudError(400, 'bad_password', 'current password is incorrect');
    }
    const hash = await hashPassword(next, this.scryptCost);
    await this.db.query('UPDATE staff SET password_hash = $2 WHERE id = $1', [auth.staff.id, hash]);
    await this.db.query('UPDATE sessions SET revoked_at = $3 WHERE staff_id = $1 AND token_hash <> $2 AND revoked_at IS NULL', [
      auth.staff.id,
      auth.session.tokenHash,
      Date.now(),
    ]);
    await this.audit.append({ actor: `staff:${auth.staff.id}`, action: 'auth.password.change', outcome: 'ok' });
  }

  async list(): Promise<StaffView[]> {
    return (await this.db.query<StaffRow>('SELECT * FROM staff ORDER BY created_at')).map(view);
  }

  async get(id: string): Promise<StaffView> {
    const row = await this.row(id);
    if (!row) throw notFound();
    return view(row);
  }

  async update(id: string, patch: { role?: PlatformRole; disabled?: boolean; displayName?: string }, by: string): Promise<StaffView> {
    const row = await this.row(id);
    if (!row) throw notFound();
    if (id === by && (patch.role !== undefined || patch.disabled !== undefined)) throw forbidden('you cannot change your own role or disable yourself');
    const losesAdmin = row.role === 'PLATFORM_SUPER_ADMIN' && !row.disabled_at && ((patch.role && patch.role !== row.role) || patch.disabled === true);
    if (losesAdmin) {
      const [{ n }] = (await this.db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM staff WHERE role = 'PLATFORM_SUPER_ADMIN' AND disabled_at IS NULL",
      )) as [{ n: number }];
      if (n <= 1) throw conflict('the last super admin cannot be removed');
    }
    const now = Date.now();
    await this.db.tx(async (t) => {
      if (patch.role) await t.query('UPDATE staff SET role = $2 WHERE id = $1', [id, patch.role]);
      if (patch.displayName) await t.query('UPDATE staff SET display_name = $2 WHERE id = $1', [id, patch.displayName.trim()]);
      if (patch.disabled === true) {
        await t.query('UPDATE staff SET disabled_at = $2 WHERE id = $1 AND disabled_at IS NULL', [id, now]);
        await t.query('UPDATE sessions SET revoked_at = $2 WHERE staff_id = $1 AND revoked_at IS NULL', [id, now]);
      }
      if (patch.disabled === false) await t.query('UPDATE staff SET disabled_at = NULL, failed_logins = 0, locked_until = NULL WHERE id = $1', [id]);
      // A role change ends assignments: a new role starts with no homes.
      if (patch.role && patch.role !== row.role) {
        await t.query('UPDATE assignments SET revoked_at = $2 WHERE staff_id = $1 AND revoked_at IS NULL', [id, now]);
      }
    });
    await this.audit.append({ actor: `staff:${by}`, action: 'staff.update', outcome: 'ok', target: `staff:${id}`, details: { ...patch, previousRole: row.role } });
    return view((await this.row(id))!);
  }

  /** Clears password and TOTP, ends sessions and issues a new one-time setup link. */
  async resetCredentials(id: string, by: string): Promise<{ setupToken: string }> {
    const row = await this.row(id);
    if (!row) throw notFound();
    if (id === by) throw forbidden('ask another super admin to reset your credentials');
    const now = Date.now();
    await this.db.tx(async (t) => {
      await t.query('UPDATE staff SET password_hash = NULL, totp_secret = NULL, totp_pending = NULL, totp_last_step = NULL WHERE id = $1', [id]);
      await t.query('UPDATE sessions SET revoked_at = $2 WHERE staff_id = $1 AND revoked_at IS NULL', [id, now]);
      await t.query('UPDATE staff_setup_tokens SET used_at = $2 WHERE staff_id = $1 AND used_at IS NULL', [id, now]);
    });
    const setupToken = await this.issueSetupToken(id);
    await this.audit.append({ actor: `staff:${by}`, action: 'staff.reset_credentials', outcome: 'ok', target: `staff:${id}` });
    return { setupToken };
  }

  private async issueSetupToken(staffId: string): Promise<string> {
    const token = newToken();
    await this.db.query('INSERT INTO staff_setup_tokens (token_hash, staff_id, expires_at) VALUES ($1, $2, $3)', [
      sha256(token),
      staffId,
      Date.now() + SETUP_TOKEN_TTL_MS,
    ]);
    return token;
  }

  private async newSession(staffId: string): Promise<string> {
    const token = newToken();
    const now = Date.now();
    await this.db.query('INSERT INTO sessions (token_hash, staff_id, mfa, created_at, expires_at, last_seen_at) VALUES ($1, $2, $3, $4, $5, $4)', [
      sha256(token),
      staffId,
      false, // Retain the legacy column without claiming a second factor was verified.
      now,
      now + SESSION_TTL_MS,
    ]);
    return token;
  }

  private async row(id: string): Promise<StaffRow | undefined> {
    const [row] = await this.db.query<StaffRow>('SELECT * FROM staff WHERE id = $1', [id]);
    return row;
  }
}

function actorOf(by: string): string {
  return by === 'cli' ? 'cli' : `staff:${by}`;
}

export function view(r: StaffRow): StaffView {
  return {
    staffId: r.id,
    email: r.email,
    displayName: r.display_name,
    role: r.role,
    mfaEnrolled: Boolean(r.totp_secret),
    setupComplete: Boolean(r.password_hash),
    disabled: Boolean(r.disabled_at),
    locked: Boolean(r.locked_until && Number(r.locked_until) > Date.now()),
    createdAt: Number(r.created_at),
  };
}
