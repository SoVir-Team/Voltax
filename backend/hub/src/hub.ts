import { existsSync } from 'node:fs';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type { HealthView } from '@voltax/contracts';
import { buildApi } from './api.js';
import { Auth } from './auth.js';
import { AutomationEngine } from './automations.js';
import { CommandManager } from './commands.js';
import type { Config } from './config.js';
import { openDb, type DB } from './db.js';
import { EventLog } from './events.js';
import { MqttLink } from './mqtt-link.js';
import { Scheduler } from './scheduler.js';
import { Store } from './store.js';

export interface Hub {
  app: FastifyInstance;
  db: DB;
  auth: Auth;
  mqtt: MqttLink;
  commands: CommandManager;
  scheduler: Scheduler;
  automations: AutomationEngine;
  events: EventLog;
  store: Store;
  start(): Promise<void>;
  stop(): Promise<void>;
}

type HubConfig = Pick<
  Config,
  'HUB_ID' | 'HUB_NAME' | 'DB_PATH' | 'BACKUP_DIR' | 'MQTT_URL' | 'MQTT_USERNAME' | 'MQTT_PASSWORD' | 'TZ' | 'VOLTAX_VERSION' | 'TIME_SYNC_FILE'
> & { UI_DIR?: string };

/** Wires every module. Nothing here talks to the cloud: the hub works fully offline. */
export async function createHub(config: HubConfig, serverOptions: FastifyServerOptions = {}): Promise<Hub> {
  const startedAt = Date.now();
  const db = openDb(config.DB_PATH, { backupDir: config.BACKUP_DIR });
  const events = new EventLog(db);
  const store = new Store(db);
  const auth = new Auth(db);

  // The app logger only exists after buildApi(); MQTT logs go through it once it does.
  let app: FastifyInstance | undefined;
  const mqttLog = {
    info: (o: object | string, m?: string) => app?.log.info(o, m),
    warn: (o: object | string, m?: string) => app?.log.warn(o, m),
  };
  const mqtt = new MqttLink(
    { url: config.MQTT_URL, username: config.MQTT_USERNAME, password: config.MQTT_PASSWORD, hubId: config.HUB_ID },
    store,
    events,
    mqttLog,
  );
  const commands = new CommandManager(db, store, events, mqtt);
  const scheduler = new Scheduler(db, commands, events, config.TZ);
  const automations = new AutomationEngine(db, commands, events);
  mqtt.onState((r) => automations.handleState(r));

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
      timeSynced: existsSync(config.TIME_SYNC_FILE),
      uptime: Math.round((Date.now() - startedAt) / 1000),
    };
  };

  const api = await buildApi(
    {
      hubId: config.HUB_ID,
      hubName: config.HUB_NAME,
      version: config.VOLTAX_VERSION,
      store,
      events,
      commands,
      auth,
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
    mqtt,
    commands,
    scheduler,
    automations,
    events,
    store,
    async start() {
      const failed = commands.recoverAfterRestart();
      if (failed) api.log.warn({ failed }, 'failed commands left in flight by previous run');
      events.append('hub.started', { version: config.VOLTAX_VERSION });
      mqtt.start();
      scheduler.start();
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
      automations.stop();
      await api.close();
      await mqtt.stop();
      db.close();
    },
  };
}
