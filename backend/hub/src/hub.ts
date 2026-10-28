import { existsSync } from 'node:fs';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type { Diagnostics, HealthView, Telemetry } from '@voltax/contracts';
import { buildApi } from './api.js';
import { AuditLog } from './audit.js';
import { Auth } from './auth.js';
import { AutomationEngine } from './automations.js';
import { CloudLink } from './cloud-link.js';
import { CommandManager } from './commands.js';
import type { Config } from './config.js';
import { openDb, type DB } from './db.js';
import { EnvelopeVerifier } from './envelope.js';
import { EventLog } from './events.js';
import { SupportGrants } from './grants.js';
import { MqttLink } from './mqtt-link.js';
import { Scheduler } from './scheduler.js';
import { Store } from './store.js';
import { UpdateDropbox } from './updates.js';

export interface Hub {
  app: FastifyInstance;
  db: DB;
  auth: Auth;
  audit: AuditLog;
  mqtt: MqttLink;
  commands: CommandManager;
  scheduler: Scheduler;
  automations: AutomationEngine;
  events: EventLog;
  store: Store;
  grants: SupportGrants;
  updates: UpdateDropbox;
  /** Only when CLOUD_URL is configured. */
  cloud: CloudLink | null;
  start(): Promise<void>;
  stop(): Promise<void>;
}

type HubConfig = Pick<
  Config,
  'HUB_ID' | 'HUB_NAME' | 'DB_PATH' | 'BACKUP_DIR' | 'MQTT_URL' | 'MQTT_USERNAME' | 'MQTT_PASSWORD' | 'TZ' | 'VOLTAX_VERSION' | 'TIME_SYNC_FILE'
> &
  Partial<Pick<Config, 'CLOUD_URL' | 'CLOUD_PASSWORD' | 'CLOUD_CA' | 'TELEMETRY_INTERVAL_MS' | 'UPDATE_DIR'>> & {
    UI_DIR?: string;
    CLOUD_COMMAND_PUBKEY_PEM?: string | null;
    /** Restart under a support grant (main.ts: graceful exit; Docker restarts the container). */
    onRestartRequested?: () => boolean;
  };

/** Wires every module. Everything works offline; the cloud link is optional and off by default. */
export async function createHub(config: HubConfig, serverOptions: FastifyServerOptions = {}): Promise<Hub> {
  const startedAt = Date.now();
  const db = openDb(config.DB_PATH, { backupDir: config.BACKUP_DIR });
  const events = new EventLog(db);
  const store = new Store(db);
  const auth = new Auth(db);
  const audit = new AuditLog(db);

  // The app logger only exists after buildApi(); MQTT logs go through it once it does.
  let app: FastifyInstance | undefined;
  const log = {
    info: (o: object | string, m?: string) => app?.log.info(o, m),
    warn: (o: object | string, m?: string) => app?.log.warn(o, m),
  };
  const mqtt = new MqttLink(
    { url: config.MQTT_URL, username: config.MQTT_USERNAME, password: config.MQTT_PASSWORD, hubId: config.HUB_ID },
    store,
    events,
    log,
  );
  const commands = new CommandManager(db, store, events, mqtt);
  const scheduler = new Scheduler(db, commands, events, config.TZ);
  const automations = new AutomationEngine(db, commands, events);
  mqtt.onState((r) => automations.handleState(r));
  const timeSynced = () => existsSync(config.TIME_SYNC_FILE);
  const verifier = new EnvelopeVerifier(db, { hubId: config.HUB_ID, publicKeyPem: config.CLOUD_COMMAND_PUBKEY_PEM ?? null, timeSynced });
  const updates = new UpdateDropbox(config.UPDATE_DIR ?? '/var/lib/voltax/update-request');

  const health = (): HealthView => {
    let dbUp = true;
    try {
      db.prepare('SELECT 1').get();
    } catch {
      dbUp = false;
    }
    const mqttUp = mqtt.connected;
    return {
      status: dbUp && mqttUp ? 'ok' : 'degraded',
      version: config.VOLTAX_VERSION,
      hubId: config.HUB_ID,
      db: dbUp ? 'up' : 'down',
      mqtt: mqttUp ? 'up' : 'down',
      timeSynced: timeSynced(),
      uptime: Math.round((Date.now() - startedAt) / 1000),
    };
  };

  // Operational metadata only (no names, states or history): what support may see under a grant.
  const diagnostics = (): Diagnostics => {
    const h = health();
    const counts = db
      .prepare("SELECT status, COUNT(*) AS n FROM commands WHERE issued_at > ? AND status IN ('confirmed', 'failed', 'expired') GROUP BY status")
      .all(Date.now() - 24 * 60 * 60 * 1000) as Array<{ status: string; n: number }>;
    const n = (s: string) => counts.find((c) => c.status === s)?.n ?? 0;
    return {
      version: h.version,
      uptime: h.uptime,
      db: h.db,
      mqtt: h.mqtt,
      timeSynced: h.timeSynced,
      devices: store.listDevices().map((d) => ({ deviceId: d.deviceId, online: d.online, lastSeen: d.lastSeen })),
      commandsLast24h: { confirmed: n('confirmed'), failed: n('failed'), expired: n('expired') },
      eventLogSeq: events.lastSeq(),
    };
  };

  // Fleet telemetry: an allow-list (connectivity, versions, online/offline). Never names or states.
  const telemetry = (): Omit<Telemetry, 'at'> => {
    const h = health();
    return {
      version: h.version,
      uptime: h.uptime,
      db: h.db,
      mqtt: h.mqtt,
      timeSynced: h.timeSynced,
      devices: store.listDevices().map((d) => ({ deviceId: d.deviceId, online: d.online })),
      update: updates.state(),
    };
  };

  const grants = new SupportGrants({
    db,
    events,
    audit,
    commands,
    store,
    verifier,
    diagnostics,
    ...(config.onRestartRequested ? { restart: config.onRestartRequested } : {}),
  });

  const cloud = config.CLOUD_URL
    ? new CloudLink(
        {
          url: config.CLOUD_URL,
          hubId: config.HUB_ID,
          username: config.HUB_ID,
          password: config.CLOUD_PASSWORD ?? '',
          ...(config.CLOUD_CA && existsSync(config.CLOUD_CA) ? { caFile: config.CLOUD_CA } : {}),
          ...(config.TELEMETRY_INTERVAL_MS ? { telemetryIntervalMs: config.TELEMETRY_INTERVAL_MS } : {}),
        },
        { db, grants, audit, telemetry },
        log,
      )
    : null;

  const api = await buildApi(
    {
      hubId: config.HUB_ID,
      hubName: config.HUB_NAME,
      version: config.VOLTAX_VERSION,
      store,
      events,
      commands,
      auth,
      audit,
      grants,
      scheduler,
      automations,
      health,
      uiDir: config.UI_DIR,
    },
    serverOptions,
  );
  app = api;

  let housekeeping: NodeJS.Timeout | undefined;

  return {
    app: api,
    db,
    auth,
    audit,
    mqtt,
    commands,
    scheduler,
    automations,
    events,
    store,
    grants,
    updates,
    cloud,
    async start() {
      const failed = commands.recoverAfterRestart();
      if (failed) api.log.warn({ failed }, 'failed commands left in flight by previous run');
      events.append('hub.started', { version: config.VOLTAX_VERSION });
      mqtt.start();
      scheduler.start();
      grants.start();
      cloud?.start();
      housekeeping = setInterval(() => {
        commands.prune();
        events.prune(30 * 24 * 60 * 60 * 1000);
        auth.pruneCodes();
      }, 60 * 60 * 1000);
      housekeeping.unref();
    },
    async stop() {
      clearInterval(housekeeping);
      scheduler.stop();
      grants.stop();
      automations.stop();
      commands.stop();
      await cloud?.stop();
      await api.close();
      await mqtt.stop();
      db.close();
    },
  };
}
