import { randomUUID } from 'node:crypto';
import type { NotificationView } from '@voltax/contracts';
import type { CloudAudit } from './audit.js';
import type { Db } from './db.js';

/** An email provider. Throw NotificationError; permanent = retrying cannot help (bad address, 5xx). */
export interface EmailChannel {
  send(message: { to: string; subject: string; text: string }): Promise<void>;
}

export class NotificationError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
  }
}

export interface GrantNotice {
  grantId: string;
  homeId: string;
  homeName: string;
  staffName: string;
  actions: string[];
  deviceIds: string[];
  endsAt: number;
  ownerContact: string | null;
  status?: string;
  reason?: string | null;
}

type Status = 'pending' | 'delivered' | 'failed' | 'cancelled';

export const RETRY_DELAYS_MS = [15_000, 60_000, 5 * 60_000, 15 * 60_000];
const SWEEP_MS = 5_000;

/**
 * Owner notices for support sessions.
 * - in_app: the hub shows it in the owner's app and confirms (startNoticeAt); the hub itself refuses
 *   every support action until then.
 * - email: sent by the cloud to the home's owner contact, when configured, with retries.
 * Fail-closed: the cloud signs control actions only when EVERY start notice for the grant is
 * delivered. A failed, slow or missing notice never grants or widens anything; it only blocks.
 */
export class Notifications {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private db: Db,
    private audit: CloudAudit,
    private email: EmailChannel | null,
    private now: () => number = Date.now,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.runDue().catch(() => undefined), SWEEP_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** The hub confirmed the owner's app was told. Queue the external notice as well. */
  async onStarted(n: GrantNotice): Promise<void> {
    const now = this.now();
    await this.insert(n, 'support.started', 'in_app', null, 'delivered', now);
    if (this.email && n.ownerContact) await this.insert(n, 'support.started', 'email', n.ownerContact, 'pending', now);
    await this.runDue();
  }

  /** Session over (or request refused): stop pending start notices; tell the owner it ended. */
  async onEnded(n: GrantNotice, wasNoticed: boolean): Promise<void> {
    const cancelled = await this.db.query<{ id: string }>(
      "UPDATE notifications SET status = 'cancelled', recipient = NULL, next_attempt_at = NULL WHERE grant_id = $1 AND kind = 'support.started' AND status = 'pending' RETURNING id",
      [n.grantId],
    );
    if (cancelled.length) {
      await this.audit.append({ actor: 'system', action: 'notify.cancelled', outcome: 'ok', target: `grant:${n.grantId}`, homeId: n.homeId, details: { count: cancelled.length } });
    }
    // Only sessions the owner was told about get an end notice (a refused request has nothing to end).
    if (wasNoticed && this.email && n.ownerContact) await this.insert(n, 'support.ended', 'email', n.ownerContact, 'pending', this.now());
    await this.runDue();
  }

  /** Fail-closed gate for control actions. */
  async startNoticeDelivered(grantId: string): Promise<boolean> {
    const rows = await this.db.query<{ channel: string; status: Status }>("SELECT channel, status FROM notifications WHERE grant_id = $1 AND kind = 'support.started'", [grantId]);
    return rows.some((r) => r.channel === 'in_app') && rows.every((r) => r.status === 'delivered');
  }

  async list(grantId: string): Promise<NotificationView[]> {
    const rows = await this.db.query<{
      id: string;
      grant_id: string;
      kind: NotificationView['kind'];
      channel: NotificationView['channel'];
      status: Status;
      attempts: number;
      last_error: string | null;
      created_at: number;
      delivered_at: number | null;
    }>('SELECT * FROM notifications WHERE grant_id = $1 ORDER BY created_at, kind, channel', [grantId]);
    return rows.map((r) => ({
      id: r.id,
      grantId: r.grant_id,
      kind: r.kind,
      channel: r.channel,
      status: r.status,
      attempts: r.attempts,
      lastError: r.last_error,
      createdAt: Number(r.created_at),
      deliveredAt: r.delivered_at === null ? null : Number(r.delivered_at),
    }));
  }

  /** Sends every pending notice that is due. Safe to call concurrently (one run at a time). */
  async runDue(): Promise<void> {
    if (this.running || !this.email) return;
    this.running = true;
    try {
      const due = await this.db.query<{ id: string; grant_id: string; home_id: string; kind: string; recipient: string | null; attempts: number }>(
        "SELECT id, grant_id, home_id, kind, recipient, attempts FROM notifications WHERE status = 'pending' AND channel = 'email' AND next_attempt_at <= $1 ORDER BY next_attempt_at LIMIT 50",
        [this.now()],
      );
      for (const row of due) await this.deliver(row);
    } finally {
      this.running = false;
    }
  }

  private async deliver(row: { id: string; grant_id: string; home_id: string; kind: string; recipient: string | null; attempts: number }): Promise<void> {
    const [g] = await this.db.query<{ status: string; ends_at: number; reason: string; actions: string; device_ids: string; staff_name: string; home_name: string; end_reason: string | null }>(
      `SELECT g.status, g.ends_at, g.reason, g.actions, g.device_ids, s.display_name AS staff_name, h.name AS home_name, g.end_reason
       FROM grants g JOIN staff s ON s.id = g.staff_id JOIN homes h ON h.id = g.home_id WHERE g.grant_id = $1`,
      [row.grant_id],
    );
    const attempts = row.attempts + 1;
    // A start notice for a session that is already over is pointless: cancel instead of sending.
    if (!g || !row.recipient || (row.kind === 'support.started' && (g.status !== 'active' || Number(g.ends_at) <= this.now()))) {
      await this.db.query("UPDATE notifications SET status = 'cancelled', recipient = NULL, next_attempt_at = NULL WHERE id = $1", [row.id]);
      return;
    }
    const message = renderEmail(row.kind, {
      homeName: g.home_name,
      staffName: g.staff_name,
      actions: JSON.parse(g.actions) as string[],
      deviceIds: JSON.parse(g.device_ids) as string[],
      endsAt: Number(g.ends_at),
      reason: g.end_reason,
    });
    try {
      await this.email!.send({ to: row.recipient, ...message });
      // Delivered: drop the address, it is not needed any more.
      await this.db.query("UPDATE notifications SET status = 'delivered', attempts = $2, delivered_at = $3, recipient = NULL, next_attempt_at = NULL, last_error = NULL WHERE id = $1", [
        row.id,
        attempts,
        this.now(),
      ]);
      await this.audit.append({ actor: 'system', action: `notify.${row.kind}`, outcome: 'ok', target: `grant:${row.grant_id}`, homeId: row.home_id, details: { channel: 'email', attempts } });
    } catch (err) {
      const permanent = err instanceof NotificationError && err.permanent;
      const giveUp = permanent || attempts > RETRY_DELAYS_MS.length;
      const error = sanitise(err);
      await this.db.query('UPDATE notifications SET status = $2, attempts = $3, next_attempt_at = $4, last_error = $5, recipient = CASE WHEN $2 = \'failed\' THEN NULL ELSE recipient END WHERE id = $1', [
        row.id,
        giveUp ? 'failed' : 'pending',
        attempts,
        giveUp ? null : this.now() + RETRY_DELAYS_MS[attempts - 1]!,
        error,
      ]);
      await this.audit.append({
        actor: 'system',
        action: `notify.${row.kind}`,
        outcome: 'error',
        target: `grant:${row.grant_id}`,
        homeId: row.home_id,
        details: { channel: 'email', attempts, final: giveUp, error },
      });
    }
  }

  private async insert(n: GrantNotice, kind: string, channel: string, recipient: string | null, status: Status, now: number): Promise<void> {
    await this.db.query(
      `INSERT INTO notifications (id, grant_id, home_id, kind, channel, recipient, status, created_at, delivered_at, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (grant_id, kind, channel) DO NOTHING`,
      [randomUUID(), n.grantId, n.homeId, kind, channel, recipient, status, now, status === 'delivered' ? now : null, status === 'pending' ? now : null],
    );
  }
}

/** Provider errors can echo credentials or addresses; keep a short, generic reason only. */
function sanitise(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<address>')
    .replace(/(pass(word)?|auth|token|key)\S*/gi, '<redacted>')
    .slice(0, 160);
}

const ACTION_TEXT: Record<string, string> = {
  'device.command': 'switch the devices listed below',
  'diagnostics.read': 'read hub health (no device states)',
  'activity.read': 'read recent activity of the devices listed below',
  'hub.restart': 'restart your hub',
};

export function renderEmail(
  kind: string,
  g: { homeName: string; staffName: string; actions: string[]; deviceIds: string[]; endsAt: number; reason: string | null },
): { subject: string; text: string } {
  if (kind === 'support.started') {
    return {
      subject: `VOLTEX support session started for ${g.homeName}`,
      text: [
        `A VOLTEX support session you approved has started for ${g.homeName}.`,
        '',
        `Staff member: ${g.staffName}`,
        `They may: ${g.actions.map((a) => ACTION_TEXT[a] ?? a).join('; ')}`,
        `Devices: ${g.deviceIds.join(', ')}`,
        `Access ends: ${new Date(g.endsAt).toUTCString()}`,
        '',
        'You can end it at any time in the VOLTEX app on your home network: Settings > Support access > Revoke.',
        'If you did not approve this, revoke it now and contact VOLTEX.',
      ].join('\n'),
    };
  }
  return {
    subject: `VOLTEX support session ended for ${g.homeName}`,
    text: [`The VOLTEX support session for ${g.homeName} (${g.staffName}) has ended${g.reason ? `: ${g.reason}` : ''}.`, '', 'The full record is in your app under Support access.'].join('\n'),
  };
}
