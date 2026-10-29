import { readFileSync } from 'node:fs';
import mqtt, { type MqttClient } from 'mqtt';
import {
  CLOUD_TOPIC_ROOT,
  cloudDownTopic,
  cloudUpTopic,
  hubMessageSchema,
  telemetrySchema,
  type HubMessage,
  type Telemetry,
} from '@voltax/contracts';
import type { AuditLog } from './audit.js';
import type { DB } from './db.js';
import type { SupportGrants } from './grants.js';

export interface CloudLinkConfig {
  url: string; // mqtts://cloud-broker:8883 in production
  hubId: string;
  username: string; // = hubId; the broker ACL limits it to voltax-cloud/<hubId>/#
  password: string;
  caFile?: string; // private CA of the cloud broker, if it is not publicly trusted
  telemetryIntervalMs?: number;
}

type Log = { info: (o: object | string, m?: string) => void; warn: (o: object | string, m?: string) => void };

const AUDIT_BATCH = 200;
const AUDIT_CURSOR_KEY = 'audit_exported_seq';

/**
 * Optional outbound link to the VOLTEX cloud. Off unless CLOUD_URL is configured: nothing at home
 * depends on it. It only carries:
 *  - down: signed envelopes, handed to SupportGrants (which verifies and authorises each one)
 *  - up:   grant status, command results, rejections, allow-listed telemetry, audit copies
 */
export class CloudLink {
  private client: MqttClient | undefined;
  private telemetryTimer: NodeJS.Timeout | undefined;
  private flushing = false;

  constructor(
    private config: CloudLinkConfig,
    private deps: { db: DB; grants: SupportGrants; audit: AuditLog; customerReady?: () => HubMessage; telemetry: () => Omit<Telemetry, 'at'> },
    private log: Log,
  ) {}

  get connected(): boolean {
    return this.client?.connected ?? false;
  }

  start(): void {
    const statusTopic = `${CLOUD_TOPIC_ROOT}/${this.config.hubId}/status`;
    this.client = mqtt.connect(this.config.url, {
      clientId: `hub-${this.config.hubId}`,
      username: this.config.username,
      password: this.config.password,
      clean: true, // no queued backlog of cloud commands after an outage: stale commands must not run
      reconnectPeriod: 5_000,
      connectTimeout: 10_000,
      ...(this.config.caFile ? { ca: readFileSync(this.config.caFile) } : {}),
      rejectUnauthorized: true,
      will: { topic: statusTopic, payload: Buffer.from('offline'), qos: 1, retain: true },
    });
    this.client.on('connect', () => {
      this.log.info({ url: redactUrl(this.config.url) }, 'cloud link connected');
      void this.client!.publishAsync(statusTopic, 'online', { qos: 1, retain: true });
      void this.client!.subscribeAsync(cloudDownTopic(this.config.hubId), { qos: 1 });
      this.sendTelemetry();
      void this.flushAudit();
    });
    this.client.on('error', (err) => this.log.warn({ err: err.message }, 'cloud link error'));
    this.client.on('message', (topic, payload) => {
      if (topic !== cloudDownTopic(this.config.hubId)) return;
      let raw: unknown;
      try {
        raw = JSON.parse(payload.toString('utf8'));
      } catch {
        raw = null;
      }
      this.deps.grants.handle(raw); // verifies signature, freshness, grant and scope; never throws
    });

    this.deps.grants.setSink((msg) => this.send(msg));
    this.deps.audit.onAppend(() => void this.flushAudit());
    this.telemetryTimer = setInterval(() => this.sendTelemetry(), this.config.telemetryIntervalMs ?? 60_000);
    this.telemetryTimer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.telemetryTimer);
    this.deps.grants.setSink(() => {});
    await this.client?.endAsync();
  }

  send(msg: HubMessage): void {
    // Validate our own output: nothing outside the protocol (e.g. extra household fields) leaves the hub.
    const parsed = hubMessageSchema.safeParse(msg);
    if (!parsed.success) {
      this.log.warn({ type: msg.type }, 'refusing to send a message that does not match the protocol');
      return;
    }
    if (!this.client?.connected) return; // grant state is re-reported on reconnect via telemetry/status queries
    void this.client.publishAsync(cloudUpTopic(this.config.hubId), JSON.stringify(parsed.data), { qos: 1 }).catch(() => {});
  }

  sendTelemetry(): void {
    const telemetry = telemetrySchema.safeParse({ ...this.deps.telemetry(), at: Date.now() });
    if (telemetry.success) this.send({ type: 'telemetry', telemetry: telemetry.data });
  }

  /** Copies audit records off the hub in order. The cursor only advances after the broker accepted a batch. */
  async flushAudit(): Promise<void> {
    if (this.flushing || !this.client?.connected) return;
    this.flushing = true;
    try {
      for (;;) {
        const cursor = Number((this.deps.db.prepare('SELECT value FROM hub_meta WHERE key = ?').get(AUDIT_CURSOR_KEY) as { value: string } | undefined)?.value ?? 0);
        const records = this.deps.audit.since(cursor, AUDIT_BATCH);
        if (records.length === 0) break;
        await this.client.publishAsync(cloudUpTopic(this.config.hubId), JSON.stringify({ type: 'audit.batch', records }), { qos: 1 });
        this.deps.db
          .prepare('INSERT INTO hub_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .run(AUDIT_CURSOR_KEY, String(records[records.length - 1]!.seq));
      }
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'audit export paused');
    } finally {
      this.flushing = false;
    }
  }
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return 'invalid url';
  }
}
