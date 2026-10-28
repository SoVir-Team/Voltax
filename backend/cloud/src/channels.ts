import nodemailer from 'nodemailer';
import webpush from 'web-push';
import type { PushSubscriptionInput } from '@voltax/contracts';
import type { Db } from './db.js';
import { badRequest } from './errors.js';
import { NotificationError, type EmailChannel } from './notifications.js';

// --- email (SMTP) --------------------------------------------------------------------------------

export interface SmtpConfig {
  url: string; // smtp://user:pass@host:587 or smtps://...; credentials come from the env file only
  from: string;
  /** Upper bound for connecting, the greeting and each socket wait (default 10 s). */
  timeoutMs?: number;
}

/** Any SMTP provider. 5xx replies are permanent; connection problems and 4xx are retried. */
export class SmtpEmail implements EmailChannel {
  private transport;

  constructor(private cfg: SmtpConfig) {
    // Bounded waits: a hanging mail server must not hold up grant handling (nodemailer defaults to minutes).
    const t = cfg.timeoutMs ?? 10_000;
    this.transport = nodemailer.createTransport(
      { url: cfg.url, connectionTimeout: t, greetingTimeout: t, socketTimeout: t * 2 },
      { disableFileAccess: true, disableUrlAccess: true },
    );
  }

  async send(message: { to: string; subject: string; text: string }): Promise<void> {
    try {
      await this.transport.sendMail({ from: this.cfg.from, to: message.to, subject: message.subject, text: message.text });
    } catch (err) {
      const code = (err as { responseCode?: number }).responseCode;
      throw new NotificationError(`smtp ${code ?? 'connection'} error`, code !== undefined && code >= 500);
    }
  }
}

// --- Web Push to staff browsers (portal alerts) ---------------------------------------------------

export interface PushSender {
  send(sub: PushSubscriptionInput, payload: string): Promise<{ statusCode: number }>;
}

export interface VapidConfig {
  subject: string; // mailto: or https: contact for the push services
  publicKey: string;
  privateKey: string;
}

export class WebPushSender implements PushSender {
  constructor(private vapid: VapidConfig) {}

  async send(sub: PushSubscriptionInput, payload: string): Promise<{ statusCode: number }> {
    try {
      const res = await webpush.sendNotification(sub, payload, {
        TTL: 3600,
        vapidDetails: { subject: this.vapid.subject, publicKey: this.vapid.publicKey, privateKey: this.vapid.privateKey },
      });
      return { statusCode: res.statusCode };
    } catch (err) {
      return { statusCode: (err as { statusCode?: number }).statusCode ?? 0 };
    }
  }
}

/**
 * Hosts of the browser push services. The server sends HTTP requests to subscription endpoints, so
 * only these are accepted (no server-side request forgery through a crafted "subscription").
 */
export const PUSH_SERVICE_HOSTS = [/^fcm\.googleapis\.com$/, /\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/, /^web\.push\.apple\.com$/, /\.push\.apple\.com$/];

export class StaffPush {
  constructor(
    private db: Db,
    private sender: PushSender | null,
    readonly publicKey: string | null,
    private allowedHosts: RegExp[] = PUSH_SERVICE_HOSTS,
  ) {}

  get enabled(): boolean {
    return this.sender !== null && this.publicKey !== null;
  }

  async subscribe(staffId: string, sub: PushSubscriptionInput): Promise<void> {
    const host = new URL(sub.endpoint).hostname;
    if (!this.allowedHosts.some((re) => re.test(host))) throw badRequest('not a supported browser push service');
    await this.db.query(
      `INSERT INTO push_subscriptions (endpoint, staff_id, p256dh, auth, created_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE SET staff_id = $2, p256dh = $3, auth = $4`,
      [sub.endpoint, staffId, sub.keys.p256dh, sub.keys.auth, Date.now()],
    );
  }

  async unsubscribe(staffId: string, endpoint: string): Promise<void> {
    await this.db.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND staff_id = $2', [endpoint, staffId]);
  }

  async count(staffId: string): Promise<number> {
    const [r] = await this.db.query<{ n: number }>('SELECT count(*)::int AS n FROM push_subscriptions WHERE staff_id = $1', [staffId]);
    return r?.n ?? 0;
  }

  /** Best effort: alerts are a convenience, never part of an authorisation decision. */
  async notify(staffId: string, message: { title: string; body: string; url?: string }): Promise<number> {
    if (!this.sender) return 0;
    const subs = await this.db.query<{ endpoint: string; p256dh: string; auth: string }>('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE staff_id = $1', [staffId]);
    let delivered = 0;
    for (const s of subs) {
      const { statusCode } = await this.sender.send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(message));
      if (statusCode >= 200 && statusCode < 300) delivered++;
      // Gone or unknown: the browser unsubscribed; forget it.
      if (statusCode === 404 || statusCode === 410) await this.db.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [s.endpoint]);
    }
    return delivered;
  }
}
