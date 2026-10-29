import { createHash, createHmac, randomBytes, randomInt, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { CloudEnvelope, HubMessage, Role } from '@voltax/contracts';
import type { Auth, Client, DeviceGrant } from './auth.js';
import type { AuditLog } from './audit.js';
import type { DB } from './db.js';

export interface CustomerMail { send(message: { to: string; subject: string; text: string }): Promise<void>; close?(): void }
export interface CustomerOptions { origin?: string; mail?: CustomerMail; cookieSecure?: boolean; scryptN?: number }
interface Account { id: string; email: string; password_hash: string; client_id: string; failed_logins: number; locked_until: number | null }
interface Invitation { id: string; email: string; role: Role; devices: string; expires_at: number; claim_expires: number | null; used_at: number | null; created_by: string | null }
const token = () => randomBytes(32).toString('base64url');
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const norm = (s: string) => s.trim().toLowerCase();
const DAY = 86400_000;
export const CUSTOMER_COOKIE = 'voltax_customer';
export const SETUP_COOKIE = 'voltax_customer_setup';
export const SESSION_TTL = 30 * DAY;
export class CustomerError extends Error { constructor(public statusCode: number, message: string) { super(message); } }

/** Household identity stays on the hub, apart from staff identity. All permission checks use its client principal. */
export class CustomerAccounts {
  private challenge = token();
  private challengeAt = performance.now();
  private dummy: Promise<string> | null = null;
  constructor(private db: DB, private auth: Auth, private audit: AuditLog, readonly options: CustomerOptions = {}) {
    if (!db.prepare("SELECT 1 FROM hub_meta WHERE key = 'customer_otp_key'").get()) {
      db.prepare('INSERT INTO hub_meta(key,value) VALUES (?,?)').run('customer_otp_key', token());
    }
  }
  private hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16).toString('base64');
    const N = this.options.scryptN ?? 2 ** 17;
    return this.derive(password, salt, N).then(key => `scrypt$${N}$${salt}$${key.toString('base64')}`);
  }
  private derive(password: string, salt: string, N: number): Promise<Buffer> {
    return new Promise((resolve, reject) => scrypt(password, Buffer.from(salt, 'base64'), 32, { N, r: 8, p: 1, maxmem: 256 * N * 8 }, (err, key) => err ? reject(err) : resolve(key)));
  }
  private async verify(password: string, encoded: string): Promise<boolean> {
    const [, n, salt, expected] = encoded.split('$');
    const actual = await this.derive(password, salt!, Number(n));
    const key = Buffer.from(expected!, 'base64');
    return actual.length === key.length && timingSafeEqual(actual, key);
  }
  get claimed(): boolean {
    return !!this.db.prepare("SELECT 1 FROM customer_accounts a JOIN clients c ON c.client_id=a.client_id WHERE c.role='owner' AND c.revoked_at IS NULL").get();
  }
  ready(): Extract<HubMessage, { type: 'customer.ready' }> {
    if (performance.now() - this.challengeAt > 240_000) { this.challenge = token(); this.challengeAt = performance.now(); }
    return { type: 'customer.ready', challenge: this.challenge, claimed: this.claimed };
  }
  /** Fresh hub-generated challenge permits bootstrap without weakening the trusted-clock gate on control commands. */
  matchesChallenge(value: string): boolean { return value === this.challenge && performance.now() - this.challengeAt < 300_000; }
  onboard(env: Extract<CloudEnvelope, { type: 'customer.onboard' }>): Extract<HubMessage, { type: 'customer.onboard.result' }> {
    const refuse = (message: string): Extract<HubMessage, { type: 'customer.onboard.result' }> => ({ type: 'customer.onboard.result', requestId: env.envelopeId, result: { ok: false, message } });
    if (env.actor.role !== 'PLATFORM_SUPER_ADMIN' || !this.matchesChallenge(env.challenge)) return refuse('onboarding request is not authorized');
    if (this.claimed) return refuse('this home already has a customer owner');
    this.challenge = token(); this.challengeAt = performance.now();
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const code = Array.from(randomBytes(10), b => alphabet[b % 32]).join('');
    const expiresAt = Date.now() + 600_000;
    this.db.transaction(() => {
      this.db.prepare("UPDATE customer_invitations SET used_at=? WHERE role='owner' AND used_at IS NULL").run(Date.now());
      this.insertInvite(code, norm(env.email), 'owner', '*', expiresAt, null);
    })();
    this.audit.append({ actor: `staff:${env.actor.staffId}`, action: 'customer.onboard', outcome: 'ok' });
    return { type: 'customer.onboard.result', requestId: env.envelopeId, result: { ok: true, code, expiresAt, email: norm(env.email) } };
  }
  private insertInvite(secret: string, email: string, role: Role, devices: DeviceGrant, expires: number, by: string | null): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO customer_invitations(id,secret_hash,email,role,devices,expires_at,created_by) VALUES(?,?,?,?,?,?,?)').run(id, hash(secret), email, role, JSON.stringify(devices), expires, by);
    return id;
  }
  private validInvite(row: Invitation | undefined): row is Invitation {
    return !!row && !row.used_at && row.expires_at > Date.now() && (row.role === 'owner' ? !this.claimed : !!(row.created_by && this.auth.get(row.created_by)?.role === 'owner'));
  }
  claim(secret: string): { setupToken: string; email: string; role: Role } {
    // Human owner codes permit a separating dash; email invitation secrets are case-sensitive.
    const normalized = secret.length <= 11 ? secret.toUpperCase().replace(/[^A-Z0-9]/g, '') : secret;
    const row = this.db.prepare('SELECT * FROM customer_invitations WHERE secret_hash=?').get(hash(normalized)) as Invitation | undefined;
    if (!this.validInvite(row)) throw new CustomerError(400, 'This invitation is invalid or expired.');
    if (row.claim_expires && row.claim_expires > Date.now()) throw new CustomerError(400, 'This invitation is already being used.');
    const setupToken = token();
    this.db.prepare('UPDATE customer_invitations SET claim_hash=?,claim_expires=? WHERE id=?').run(hash(setupToken), Date.now() + 900_000, row.id);
    return { setupToken, email: row.email, role: row.role };
  }
  setup(setupToken: string | undefined): Invitation {
    const row = setupToken ? this.db.prepare('SELECT * FROM customer_invitations WHERE claim_hash=?').get(hash(setupToken)) as Invitation | undefined : undefined;
    if (!this.validInvite(row) || !row.claim_expires || row.claim_expires <= Date.now()) throw new CustomerError(400, 'Open your invitation or enter a new homeowner code.');
    return row;
  }
  async signup(setupToken: string | undefined, email: string, name: string, password: string): Promise<void> {
    let invite = this.setup(setupToken);
    if (norm(email) !== invite.email) throw new CustomerError(400, 'Use the email address on your invitation.');
    if (this.db.prepare('SELECT 1 FROM customer_accounts WHERE email=?').get(norm(email))) throw new CustomerError(409, 'This account already exists. Sign in to accept the invitation.');
    const passwordHash = await this.hashPassword(password);
    this.db.transaction(() => {
      invite = this.setup(setupToken); // Re-check after hashing: another registration may have consumed the invite.
      if (this.db.prepare('SELECT 1 FROM customer_accounts WHERE email=?').get(norm(email))) throw new CustomerError(409, 'This account already exists. Sign in instead.');
      const clientId = randomUUID();
      this.db.prepare('INSERT INTO clients(client_id,name,role,token_hash,created_at) VALUES(?,?,?,?,?)').run(clientId, name.trim(), invite.role, hash(token()), Date.now());
      if (invite.role === 'member') this.auth.setMemberDevices(clientId, JSON.parse(invite.devices) as DeviceGrant);
      this.db.prepare('INSERT INTO customer_accounts(id,email,password_hash,client_id,created_at) VALUES(?,?,?,?,?)').run(randomUUID(), norm(email), passwordHash, clientId, Date.now());
      this.db.prepare('UPDATE customer_invitations SET used_at=? WHERE id=? AND used_at IS NULL').run(Date.now(), invite.id);
      if (invite.role === 'owner') this.db.prepare("UPDATE customer_invitations SET used_at=? WHERE role='owner' AND used_at IS NULL").run(Date.now());
    })();
    this.audit.append({ actor: 'customer', action: 'customer.signup', outcome: 'ok', details: { role: invite.role } });
  }
  async login(email: string, password: string, setupToken?: string): Promise<{ sessionToken: string; client: Client }> {
    const row = this.db.prepare('SELECT * FROM customer_accounts WHERE email=?').get(norm(email)) as Account | undefined;
    if (!row) { this.dummy ??= this.hashPassword(token()); await this.verify(password, await this.dummy); throw new CustomerError(401, 'Email or password is incorrect.'); }
    if (row.locked_until && row.locked_until > Date.now()) throw new CustomerError(429, 'Too many attempts. Try again in 15 minutes.');
    if (!(await this.verify(password, row.password_hash))) {
      const failures = row.failed_logins + 1;
      this.db.prepare('UPDATE customer_accounts SET failed_logins=?,locked_until=? WHERE id=?').run(failures >= 5 ? 0 : failures, failures >= 5 ? Date.now() + 900_000 : null, row.id);
      this.audit.append({ actor: 'customer', action: 'customer.login', outcome: 'denied' });
      throw new CustomerError(401, 'Email or password is incorrect.');
    }
    if (setupToken) {
      const invite = this.setup(setupToken);
      if (invite.email !== norm(email) || invite.role !== 'member') throw new CustomerError(403, 'This invitation belongs to another account.');
      // Rejoining is allowed only through a current owner invitation; never promotes an owner.
      const previous = this.db.prepare('SELECT role FROM clients WHERE client_id=?').get(row.client_id) as { role: Role };
      if (previous.role === 'owner') throw new CustomerError(409, 'An owner cannot accept a member invitation.');
      this.db.transaction(() => {
        this.db.prepare('UPDATE clients SET revoked_at=NULL WHERE client_id=?').run(row.client_id);
        this.auth.setMemberDevices(row.client_id, JSON.parse(invite.devices) as DeviceGrant);
        this.db.prepare('UPDATE customer_invitations SET used_at=? WHERE id=?').run(Date.now(), invite.id);
      })();
    }
    const client = this.auth.get(row.client_id);
    if (!client) throw new CustomerError(401, 'Email or password is incorrect.');
    this.db.prepare('UPDATE customer_accounts SET failed_logins=0,locked_until=NULL WHERE id=?').run(row.id);
    const sessionToken = token();
    this.db.prepare('INSERT INTO customer_sessions(token_hash,account_id,expires_at,last_seen) VALUES(?,?,?,?)').run(hash(sessionToken), row.id, Date.now() + SESSION_TTL, Date.now());
    this.audit.append({ actor: `client:${row.client_id}`, action: 'customer.login', outcome: 'ok' });
    return { sessionToken, client };
  }
  authenticate(session: string | undefined): Client | null {
    if (!session || session.length > 128) return null;
    const row = this.db.prepare('SELECT a.client_id FROM customer_sessions s JOIN customer_accounts a ON a.id=s.account_id WHERE s.token_hash=? AND s.expires_at>? AND s.last_seen>?').get(hash(session), Date.now(), Date.now() - 7 * DAY) as { client_id: string } | undefined;
    if (!row) return null;
    const client = this.auth.get(row.client_id);
    if (client) this.db.prepare('UPDATE customer_sessions SET last_seen=? WHERE token_hash=?').run(Date.now(), hash(session));
    return client;
  }
  logout(session: string | undefined): void { if (session) this.db.prepare('DELETE FROM customer_sessions WHERE token_hash=?').run(hash(session)); }
  private mailConfig(): { mail: CustomerMail; origin: string } {
    if (!this.options.mail || !this.options.origin) throw new CustomerError(503, 'Email is unavailable. Please contact VOLTEX to configure email delivery.');
    return { mail: this.options.mail, origin: this.options.origin };
  }
  async invite(owner: Client, emailInput: string, devices: DeviceGrant): Promise<{ invitationId: string; expiresAt: number }> {
    if (this.auth.get(owner.clientId)?.role !== 'owner') throw new CustomerError(403, 'Only the homeowner can invite family.');
    const { mail, origin } = this.mailConfig();
    const email = norm(emailInput);
    const existing = this.db.prepare('SELECT c.role FROM customer_accounts a JOIN clients c ON c.client_id=a.client_id WHERE a.email=? AND c.revoked_at IS NULL').get(email) as { role: Role } | undefined;
    if (existing) throw new CustomerError(409, 'This person already has access. Edit their permissions instead.');
    const secret = token();
    const expiresAt = Date.now() + DAY;
    const id = this.insertInvite(secret, email, 'member', devices, expiresAt, owner.clientId);
    try { await mail.send({ to: email, subject: 'You are invited to your VOLTEX home', text: `${owner.name} invited you to their VOLTEX home.\n\nAccept invitation: ${origin}/#invite=${encodeURIComponent(secret)}\n\nCreate your account, then sign in. This link expires in 24 hours and works once. If you did not expect this invitation, ignore it.` }); }
    catch { this.db.prepare('DELETE FROM customer_invitations WHERE id=?').run(id); throw new CustomerError(503, 'The invitation could not be sent. Please try again later.'); }
    this.db.prepare("UPDATE customer_invitations SET used_at=? WHERE email=? AND role='member' AND id<>? AND used_at IS NULL").run(Date.now(), email, id);
    this.audit.append({ actor: `client:${owner.clientId}`, action: 'customer.invite', outcome: 'ok', target: id });
    return { invitationId: id, expiresAt };
  }
  invitations(): Array<{ invitationId: string; email: string; expiresAt: number }> {
    return (this.db.prepare("SELECT id,email,expires_at FROM customer_invitations WHERE role='member' AND used_at IS NULL AND expires_at>? ORDER BY expires_at DESC LIMIT 100").all(Date.now()) as { id: string; email: string; expires_at: number }[]).map(r => ({ invitationId: r.id, email: r.email, expiresAt: r.expires_at }));
  }
  revokeInvite(id: string): void { this.db.prepare("UPDATE customer_invitations SET used_at=? WHERE id=? AND role='member'").run(Date.now(), id); }
  private otpHash(email: string, code: string): string {
    const { value } = this.db.prepare("SELECT value FROM hub_meta WHERE key='customer_otp_key'").get() as { value: string };
    return createHmac('sha256', value).update(`${email}:${code}`).digest('hex');
  }
  async forgot(emailInput: string): Promise<void> {
    const { mail } = this.mailConfig();
    const email = norm(emailInput);
    const account = this.db.prepare('SELECT a.id FROM customer_accounts a JOIN clients c ON c.client_id=a.client_id WHERE a.email=? AND c.revoked_at IS NULL').get(email);
    if (!account) return; // Public response does not reveal whether the email is registered.
    const previous = this.db.prepare('SELECT sent_at FROM customer_recovery WHERE email=?').get(email) as { sent_at: number } | undefined;
    if (previous && Date.now() - previous.sent_at < 60_000) return;
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const codeHash = this.otpHash(email, code);
    this.db.prepare('INSERT OR REPLACE INTO customer_recovery(email,code_hash,expires_at,attempts,sent_at) VALUES(?,?,?,0,?)').run(email, codeHash, Date.now() + 600_000, Date.now());
    try { await mail.send({ to: email, subject: 'Your VOLTEX password reset code', text: `Your password reset code is ${code}.\n\nIt expires in 10 minutes and works once. If you did not request a reset, ignore this email. Never share this code.` }); }
    catch { this.db.prepare('DELETE FROM customer_recovery WHERE email=? AND code_hash=?').run(email, codeHash); throw new CustomerError(503, 'Password recovery email could not be sent. Please try again later.'); }
    this.audit.append({ actor: 'customer', action: 'customer.recovery.request', outcome: 'ok' });
  }
  async reset(emailInput: string, code: string, password: string): Promise<void> {
    const email = norm(emailInput);
    const codeHash = this.otpHash(email, code);
    const check = () => {
      const row = this.db.prepare('SELECT * FROM customer_recovery WHERE email=?').get(email) as { code_hash: string; expires_at: number; attempts: number } | undefined;
      if (!row || row.expires_at <= Date.now() || row.attempts >= 5 || !timingSafeEqual(Buffer.from(row.code_hash, 'hex'), Buffer.from(codeHash, 'hex'))) throw new CustomerError(400, 'The reset code is invalid or expired.');
    };
    try { check(); } catch (err) { this.db.prepare('UPDATE customer_recovery SET attempts=attempts+1 WHERE email=?').run(email); throw err; }
    const passwordHash = await this.hashPassword(password);
    this.db.transaction(() => {
      check();
      const account = this.db.prepare('SELECT * FROM customer_accounts WHERE email=?').get(email) as Account | undefined;
      if (!account || !this.auth.get(account.client_id)) throw new CustomerError(400, 'The reset code is invalid or expired.');
      this.db.prepare('UPDATE customer_accounts SET password_hash=?,failed_logins=0,locked_until=NULL WHERE id=?').run(passwordHash, account.id);
      this.db.prepare('DELETE FROM customer_sessions WHERE account_id=?').run(account.id);
      this.db.prepare('DELETE FROM customer_recovery WHERE email=?').run(email);
    })();
    this.audit.append({ actor: 'customer', action: 'customer.password.reset', outcome: 'ok' });
  }
}
