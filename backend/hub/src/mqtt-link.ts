import mqtt, { type MqttClient } from 'mqtt';
import {
  TOPIC_ROOT,
  boolToPayload,
  commandTopic,
  entityId,
  hubSubscriptions,
  parseTopic,
  payloadToBool,
  type EntityRef,
} from '@voltax/contracts';
import type { EventLog } from './events.js';
import type { Store } from './store.js';

export interface StateReport {
  entityId: string;
  value: boolean;
  /** Retained snapshot replayed on (re)subscribe, not a live transition. */
  retained: boolean;
  /** False for duplicates (same value as already stored). */
  changed: boolean;
}

type StateListener = (report: StateReport) => void;

interface Logger {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
}

export interface MqttLinkOptions {
  url: string;
  username: string;
  password: string;
  hubId: string;
}

/** Hub <-> local Mosquitto. Devices only reach the hub through this broker. */
export class MqttLink {
  private client: MqttClient | null = null;
  private stateListeners = new Set<StateListener>();

  constructor(
    private opts: MqttLinkOptions,
    private store: Store,
    private events: EventLog,
    private log: Logger,
  ) {}

  get connected(): boolean {
    return this.client?.connected ?? false;
  }

  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  start(): void {
    const { url, username, password, hubId } = this.opts;
    // clean: true => the broker keeps no session for us, so nothing stale is queued while we are away.
    const client = mqtt.connect(url, { username, password, clientId: `hub-${hubId}`, clean: true, reconnectPeriod: 2000 });
    this.client = client;

    client.on('connect', () => {
      this.log.info('mqtt connected');
      client.subscribe([...hubSubscriptions(hubId), `${TOPIC_ROOT}/${hubId}/+/+/+/command`], { qos: 1 }, (err) => {
        if (err) this.log.warn({ err: err.message }, 'mqtt subscribe failed');
      });
    });
    client.on('close', () => this.log.warn('mqtt disconnected'));
    client.on('error', (err) => this.log.warn({ err: err.message }, 'mqtt error'));
    client.on('message', (topic, payload, packet) => this.handle(topic, payload.toString('utf8'), packet.retain ?? false));
  }

  async publishCommand(ref: EntityRef, value: boolean): Promise<void> {
    if (!this.client?.connected) throw new Error('mqtt not connected');
    // Never retained: a rebooting device must not pick up an old command.
    await this.client.publishAsync(commandTopic(this.opts.hubId, ref), boolToPayload(value), { qos: 1, retain: false });
  }

  async stop(): Promise<void> {
    await this.client?.endAsync();
    this.client = null;
  }

  private handle(topic: string, payload: string, retained: boolean): void {
    const parsed = parseTopic(topic);
    if (!parsed || parsed.hubId !== this.opts.hubId) return;

    if (parsed.kind === 'command') {
      // Defence in depth: clear any retained command so it can never replay.
      if (retained && payload.length > 0) {
        this.log.warn({ topic }, 'clearing retained command');
        this.client?.publish(topic, '', { qos: 1, retain: true });
      }
      return;
    }

    if (parsed.kind === 'status') {
      const online = payload.trim() === 'online';
      if (this.store.setDeviceOnline(parsed.deviceId, online)) {
        this.events.append('device.online', { deviceId: parsed.deviceId, online });
      }
      return;
    }

    const value = payloadToBool(payload);
    if (value === null) return;
    const { changed, entity } = this.store.reportState(parsed, value);
    if (changed) {
      this.events.append('entity.state', { entityId: entity.entityId, state: value, stateVersion: entity.stateVersion, retained });
    }
    const report: StateReport = { entityId: entityId(parsed), value, retained, changed };
    for (const listener of this.stateListeners) listener(report);
  }
}
