import webpush from 'web-push';
import { PUSH_SERVICE_HOSTS, type HubEvent, type PushSubscriptionInput, type Role } from '@voltax/contracts';
import { eventVisible } from './api.js';
import type { Auth } from './auth.js';
import type { DB } from './db.js';
import type { EventLog } from './events.js';

export interface PushSender {
  send(sub: PushSubscriptionInput, payload: string): Promise<{ statusCode: number }>;
}

export interface PushMessage {
  title: string;
  body: string;
  url: string;
}

/** Sends through the browser's push service (end-to-end encrypted payload, VAPID-signed). */
export class WebPushSender implements PushSender {
  constructor(private vapid: { subject: string; publicKey: string; privateKey: string }) {}

  async send(sub: PushSubscriptionInput, payload: string): Promise<{ statusCode: number }> {
    try {
      const res = await webpush.sendNotification(sub, payload, { TTL: 3600, vapidDetails: this.vapid });
      return { statusCode: res.statusCode };
    } catch (err) {
      return { statusCode: (err as { statusCode?: number }).statusCode ?? 0 };
    }
  }
}

/** The hub's own VAPID key pair, made on first use and kept in the hub database (never leaves the Pi). */
export function hubVapidKeys(db: DB): { publicKey: string; privateKey: string } {
  const row = db.prepare("SELECT value FROM hub_meta WHERE key = 'vapid_keys'").get() as { value: string } | undefined;
  if (row) return JSON.parse(row.value) as { publicKey: string; privateKey: string };
  const keys = webpush.generateVAPIDKeys();
  db.prepare("INSERT INTO hub_meta (key, value) VALUES ('vapid_keys', ?)").run(JSON.stringify(keys));
  return keys;
}

/** Which events each role is told about (members only for devices they may see). */
const TOPICS: Record<Role, ReadonlySet<string>> = {
  owner: new Set(['support.requested', 'support.started', 'support.ended', 'update.offered', 'device.online']),
  member: new Set(['support.started', 'support.ended', 'device.online']),
};

/**
 * Opt-in browser notifications for the people in this home. Best effort and outbound only: a
 * failed or missing push never blocks or authorises anything; the in-app event log is the record.
 */
export class HubPush {
  private unsubscribeEvents: (() => void) | null = null;

  constructor(
    private db: DB,
    private auth: Auth,
    private events: EventLog,
    private sender: PushSender | null,
    readonly publicKey: string | null,
    private allowedHosts: RegExp[] = PUSH_SERVICE_HOSTS,
  ) {
    // A removed phone stops getting notifications at once.
    auth.onRevoke((clientId) => this.db.prepare('DELETE FROM push_subscriptions WHERE client_id = ?').run(clientId));
  }

  start(): void {
    this.unsubscribeEvents = this.events.subscribe((e) => void this.onEvent(e).catch(() => undefined));
  }

  stop(): void {
    this.unsubscribeEvents?.();
  }

  subscribe(clientId: string, sub: PushSubscriptionInput): 'ok' | 'bad_host' {
    if (!this.allowedHosts.some((re) => re.test(new URL(sub.endpoint).hostname))) return 'bad_host';
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, client_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (endpoint) DO UPDATE SET client_id = excluded.client_id, p256dh = excluded.p256dh, auth = excluded.auth`,
      )
      .run(sub.endpoint, clientId, sub.keys.p256dh, sub.keys.auth, Date.now());
    return 'ok';
  }

  unsubscribe(clientId: string, endpoint: string): void {
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND client_id = ?').run(endpoint, clientId);
  }

  count(clientId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE client_id = ?').get(clientId) as { n: number }).n;
  }

  /** Sends the event to every subscribed client allowed to see it. Returns the number delivered. */
  async onEvent(event: HubEvent): Promise<number> {
    const message = describe(event, this.db);
    if (!message || !this.sender) return 0;
    const subs = this.db.prepare('SELECT endpoint, client_id, p256dh, auth FROM push_subscriptions').all() as Array<{ endpoint: string; client_id: string; p256dh: string; auth: string }>;
    let delivered = 0;
    for (const s of subs) {
      const client = this.auth.get(s.client_id); // current role and devices, never a cached copy
      if (!client || !TOPICS[client.role].has(event.type) || !eventVisible(this.auth.deviceScope(client), event)) continue;
      const { statusCode } = await this.sender.send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(message));
      if (statusCode >= 200 && statusCode < 300) delivered++;
      if (statusCode === 404 || statusCode === 410) this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(s.endpoint);
    }
    return delivered;
  }
}

/** Short, plain text. Only the device's own label; never states, schedules or history. */
function describe(e: HubEvent, db: DB): PushMessage | null {
  const p = e.payload;
  switch (e.type) {
    case 'support.requested':
      return { title: 'VOLTEX support is asking for access', body: 'Open the app to approve or reject the request.', url: '/access/' };
    case 'support.started':
      return { title: 'Support session started', body: 'A VOLTEX support session is now active on your hub.', url: '/access/' };
    case 'support.ended':
      return p.wasActive ? { title: 'Support session ended', body: 'VOLTEX support no longer has access to your hub.', url: '/access/' } : null;
    case 'update.offered':
      return { title: 'Hub update available', body: `Version ${String(p.version)} is ready. Open the app to approve it.`, url: '/hub/' };
    case 'device.online': {
      if (p.online !== false) return null;
      const row = db.prepare('SELECT name, room FROM devices WHERE device_id = ?').get(p.deviceId) as { name: string; room: string | null } | undefined;
      return { title: `${row?.room ?? row?.name ?? String(p.deviceId)} is offline`, body: 'The device stopped reporting to your hub.', url: '/' };
    }
    default:
      return null;
  }
}
