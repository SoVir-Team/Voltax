import { readFileSync } from 'node:fs';
import mqtt, { type MqttClient } from 'mqtt';
import { CLOUD_TOPIC_ROOT, cloudDownTopic, hubIdSchema, hubMessageSchema, type HubMessage, type SignedEnvelope } from '@voltax/contracts';
import type { HubTransport } from './grants.js';

/** Broker username of the cloud service itself. Hubs use their hub id. */
export const CLOUD_SERVICE_USER = 'voltax-cloud-service';

const HUB_TOPIC = new RegExp(`^${CLOUD_TOPIC_ROOT}/([a-z0-9][a-z0-9-]{2,63})/(up|status|down)$`);

/**
 * Cloud broker ACL, used by EMQX (HTTP authorisation) and by the test brokers. A hub may only
 * publish its own up/status topics and subscribe to its own down topic; the cloud service may only
 * publish down topics and subscribe to up/status. Nothing else, no wildcards for hubs.
 */
export function brokerAllows(username: string, action: 'publish' | 'subscribe', topic: string): boolean {
  if (username === CLOUD_SERVICE_USER) {
    if (action === 'subscribe') return topic === `${CLOUD_TOPIC_ROOT}/+/up` || topic === `${CLOUD_TOPIC_ROOT}/+/status`;
    const m = HUB_TOPIC.exec(topic);
    return Boolean(m && m[2] === 'down');
  }
  if (!hubIdSchema.safeParse(username).success) return false;
  if (action === 'subscribe') return topic === cloudDownTopic(username);
  return topic === `${CLOUD_TOPIC_ROOT}/${username}/up` || topic === `${CLOUD_TOPIC_ROOT}/${username}/status`;
}

export interface BrokerLinkConfig {
  url: string;
  password: string;
  caFile?: string;
  /** How long start() waits for the first connection before carrying on without it (default 10 s). */
  startTimeoutMs?: number;
  reconnectMs?: number;
  /** Retry interval for a refused subscription (default 5 s). */
  resubscribeMs?: number;
}

const SUBSCRIPTIONS = [`${CLOUD_TOPIC_ROOT}/+/up`, `${CLOUD_TOPIC_ROOT}/+/status`];

export interface BrokerLog {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

/**
 * The cloud's connection to the cloud broker: publishes signed envelopes to hubs and receives hub
 * messages. The hub id comes from the topic, which the broker ACL ties to the hub's credential.
 */
export class BrokerLink implements HubTransport {
  private client: MqttClient | null = null;
  readonly online = new Map<string, boolean>();
  private dropped = 0;
  // Messages from one hub are handled strictly in order (e.g. "active" before "ended").
  private chains = new Map<string, Promise<void>>();

  constructor(
    private config: BrokerLinkConfig,
    private onMessage: (hubId: string, msg: HubMessage) => Promise<void>,
    private log: BrokerLog,
  ) {}

  get connected(): boolean {
    return this.client?.connected ?? false;
  }

  /**
   * Connects, and keeps reconnecting for as long as the cloud runs. The cloud starts even when the
   * broker is not reachable yet (on a cold start EMQX's auth webhook is this very process): until
   * the link is up, publish() refuses, so nothing reaches a hub, and the API keeps answering.
   */
  async start(): Promise<void> {
    this.client = mqtt.connect(this.config.url, {
      username: CLOUD_SERVICE_USER,
      password: this.config.password,
      clientId: `voltax-cloud-${process.pid}-${Math.random().toString(16).slice(2, 8)}`,
      clean: true,
      reconnectPeriod: this.config.reconnectMs ?? 2000,
      ...(this.config.caFile ? { ca: readFileSync(this.config.caFile) } : {}),
    });
    this.client.on('message', (topic, payload) => void this.receive(topic, payload));
    this.client.on('error', (err) => this.log.warn({ err: err.message }, 'cloud broker error'));
    let subscribed: Promise<void> = Promise.resolve();
    this.client.on('connect', () => {
      this.log.info({}, 'connected to cloud broker');
      subscribed = this.subscribe();
    });
    const connected = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), this.config.startTimeoutMs ?? 10_000);
      this.client!.once('connect', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (connected) await subscribed; // so no early hub message is missed
    else this.log.warn({}, 'cloud broker not reachable yet; retrying in the background (remote support is unavailable until then)');
  }

  /**
   * Subscribes to every hub's up/status topics. A refused subscription (EMQX answers 0x80 while its
   * authorisation source is still starting) is retried: connected-but-deaf would silently lose
   * every grant status and command result.
   */
  private async subscribe(): Promise<void> {
    const client = this.client;
    while (client && client === this.client && client.connected) {
      try {
        const granted = await client.subscribeAsync(SUBSCRIPTIONS, { qos: 1 });
        if (granted.every((g) => g.qos !== 128)) return;
      } catch {
        /* refused or interrupted: retry below */
      }
      this.log.warn({}, 'cloud broker refused the subscription; retrying');
      await new Promise((r) => setTimeout(r, this.config.resubscribeMs ?? 5000));
    }
  }

  async stop(): Promise<void> {
    await this.client?.endAsync();
    this.client = null;
  }

  async publish(hubId: string, envelope: SignedEnvelope): Promise<void> {
    if (!this.client?.connected) throw new Error('cloud broker not connected');
    await this.client.publishAsync(cloudDownTopic(hubId), JSON.stringify(envelope), { qos: 1 });
  }

  get droppedMessages(): number {
    return this.dropped;
  }

  private async receive(topic: string, payload: Buffer): Promise<void> {
    const m = HUB_TOPIC.exec(topic);
    if (!m) return;
    const hubId = m[1]!;
    if (m[2] === 'status') {
      this.online.set(hubId, payload.toString() === 'online');
      return;
    }
    if (m[2] !== 'up' || payload.length > 1_000_000) return void this.dropped++;
    let json: unknown;
    try {
      json = JSON.parse(payload.toString('utf8'));
    } catch {
      return void this.dropped++;
    }
    const parsed = hubMessageSchema.safeParse(json);
    if (!parsed.success) return void this.dropped++;
    const next = (this.chains.get(hubId) ?? Promise.resolve())
      .then(() => this.onMessage(hubId, parsed.data))
      .catch((err: Error) => this.log.warn({ hubId, type: parsed.data.type, err: err.message }, 'hub message handling failed'));
    this.chains.set(hubId, next);
    await next;
  }
}
