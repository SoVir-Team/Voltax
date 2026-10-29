import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Aedes } from 'aedes';
import mqtt, { type MqttClient } from 'mqtt';
import { createHub, type Hub } from '../src/hub.js';
import type { PushSender } from '../src/push.js';
import type { CustomerOptions } from '../src/customer-accounts.js';

export const HUB_ID = 'test-hub';
export const RELAY = 'esp-relay-01.switch.relay_1';
export const BUTTON = 'esp-relay-01.binary_sensor.boot_button';
const PREFIX = `voltax/${HUB_ID}/esp-relay-01`;

/** In-process MQTT broker standing in for Mosquitto (ACLs are tested separately against real Mosquitto). */
export async function startBroker(): Promise<{ url: string; close: () => Promise<void> }> {
  const broker = await Aedes.createBroker();
  const server: Server = createServer(broker.handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `mqtt://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => broker.close(() => server.close(() => resolve()))),
  };
}

/**
 * Simulated ESPHome relay device: reports state retained, obeys commands,
 * and can be told to ignore commands (dead relay) or go offline.
 */
export class FakeDevice {
  client!: MqttClient;
  relay = false;
  ignoreCommands = false;
  received: Array<{ topic: string; payload: string; retain: boolean }> = [];

  async connect(url: string, auth?: { username: string; password: string }): Promise<void> {
    this.client = await mqtt.connectAsync(url, {
      ...auth,
      clientId: 'esp-relay-01',
      clean: true,
      will: { topic: `${PREFIX}/status`, payload: Buffer.from('offline'), qos: 1, retain: true },
    });
    this.client.on('message', (topic, payload, packet) => {
      this.received.push({ topic, payload: payload.toString(), retain: packet.retain ?? false });
      if (this.ignoreCommands) return;
      const v = payload.toString();
      if (v === 'ON' || v === 'OFF') this.setRelay(v === 'ON').catch(() => {}); // may race with close() in tests
    });
    await this.client.subscribeAsync(`${PREFIX}/switch/relay_1/command`, { qos: 0 });
    await this.client.publishAsync(`${PREFIX}/status`, 'online', { qos: 1, retain: true });
    await this.setRelay(this.relay);
    await this.publishButton(false);
  }

  async setRelay(on: boolean): Promise<void> {
    this.relay = on;
    await this.client.publishAsync(`${PREFIX}/switch/relay_1/state`, on ? 'ON' : 'OFF', { qos: 1, retain: true });
  }

  async publishButton(pressed: boolean): Promise<void> {
    await this.client.publishAsync(`${PREFIX}/binary_sensor/boot_button/state`, pressed ? 'ON' : 'OFF', { qos: 1, retain: true });
  }

  async goOffline(): Promise<void> {
    await this.client.publishAsync(`${PREFIX}/status`, 'offline', { qos: 1, retain: true });
  }

  async close(): Promise<void> {
    await this.client?.endAsync();
  }
}

export interface TestEnv {
  hub: Hub;
  device: FakeDevice;
  brokerUrl: string;
  dir: string;
  close: () => Promise<void>;
}

/** A real local broker (e.g. Mosquitto with the deploy/pi ACL) used instead of the in-process one. */
export interface LocalBroker {
  url: string;
  close: () => Promise<void>;
  hubPassword: string;
  device: { username: string; password: string };
}

export async function startEnv(
  opts: { connectDevice?: boolean; dir?: string; cloudKeyPem?: string; timeSynced?: boolean; cloudUrl?: string; cloudPassword?: string; localBroker?: LocalBroker; version?: string; pushSender?: PushSender | null; uiDir?: string; customer?: CustomerOptions; staffPortal?: string } = {},
): Promise<TestEnv> {
  const broker = opts.localBroker ?? (await startBroker());
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'voltax-hub-'));
  const syncFile = join(dir, 'time-synced');
  if (opts.timeSynced) writeFileSync(syncFile, '');
  const hub = await createHub(
    {
      HUB_ID,
      HUB_NAME: 'Test Hub',
      DB_PATH: join(dir, 'hub.db'),
      BACKUP_DIR: join(dir, 'backups'),
      MQTT_URL: broker.url,
      MQTT_USERNAME: 'hub',
      MQTT_PASSWORD: opts.localBroker?.hubPassword ?? 'x',
      TZ: 'UTC',
      VOLTAX_VERSION: opts.version ?? 'test',
      TIME_SYNC_FILE: syncFile,
      CLOUD_COMMAND_PUBKEY_PEM: opts.cloudKeyPem ?? null,
      UPDATE_DIR: join(dir, 'update-request'),
      pushSender: opts.pushSender ?? null, // tests never reach real push services
      ...(opts.uiDir ? { UI_DIR: opts.uiDir } : {}),
      ...(opts.customer ? { customerOptions: opts.customer } : {}),
      ...(opts.staffPortal ? { STAFF_PORTAL_URL: opts.staffPortal } : {}),
      ...(opts.cloudUrl ? { CLOUD_URL: opts.cloudUrl, CLOUD_PASSWORD: opts.cloudPassword ?? 'x', TELEMETRY_INTERVAL_MS: 5_000 } : {}),
    },
    { logger: false },
  );
  await hub.start();
  await waitFor(() => hub.mqtt.connected);

  const device = new FakeDevice();
  if (opts.connectDevice !== false) {
    await device.connect(broker.url, opts.localBroker?.device);
    await waitFor(() => hub.store.getEntity(RELAY) !== null && hub.store.isDeviceOnline('esp-relay-01'));
  }

  return {
    hub,
    device,
    brokerUrl: broker.url,
    dir,
    close: async () => {
      await device.close();
      await hub.stop();
      await broker.close();
      if (!opts.dir) rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Pair an owner through the real API and return its bearer header. */
export async function pairOwner(hub: Hub): Promise<{ authorization: string; clientId: string }> {
  const { code } = hub.auth.createPairingCode('owner');
  const res = await hub.app.inject({ method: 'POST', url: '/api/v1/pair', payload: { pairingCode: code, clientName: 'test phone' } });
  const body = res.json<{ token: string; clientId: string }>();
  return { authorization: `Bearer ${body.token}`, clientId: body.clientId };
}
