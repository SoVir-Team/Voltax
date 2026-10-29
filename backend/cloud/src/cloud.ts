import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type { HubMessage } from '@voltax/contracts';
import { buildCloudApi, type CloudApiConfig } from './api.js';
import { CloudAudit } from './audit.js';
import { AuditExport } from './audit-export.js';
import { BrokerLink, type BrokerLinkConfig, type BrokerLog } from './broker.js';
import { StaffPush, type PushSender } from './channels.js';
import { AuditCheckpoints } from './checkpoints.js';
import type { ScryptCost } from './crypto.js';
import { migrate, type Db } from './db.js';
import { FleetService } from './fleet.js';
import { GrantService, type HubTransport } from './grants.js';
import { HomesService } from './homes.js';
import { HubAuditStore } from './hub-audit.js';
import { Notifications, type EmailChannel } from './notifications.js';
import { fleetRoutes } from './routes-fleet.js';
import { supportRoutes } from './routes-support.js';
import type { ObjectStore } from './s3.js';
import { EnvelopeSigner } from './signer.js';
import { StaffService } from './staff.js';
import { CustomerOnboarding } from './customer-onboarding.js';

export interface CloudOptions {
  db: Db;
  dataKey: Buffer;
  /** Ed25519 private key (PEM) that signs envelopes to hubs. Absent = no remote support actions. */
  commandKeyPem?: string;
  /** Ed25519 private key (PEM) for audit checkpoints. Keep it apart from the database. */
  auditKeyPem?: string;
  /** minisign public key (.pub file contents) that every registered release must be signed with. */
  releasePublicKey?: string;
  api: CloudApiConfig;
  scryptCost?: ScryptCost;
  server?: FastifyServerOptions;
  /** Real cloud broker connection. Tests may pass `transport` instead. */
  broker?: BrokerLinkConfig;
  transport?: HubTransport;
  email?: EmailChannel | null;
  push?: { sender: PushSender; publicKey: string; allowedHosts?: RegExp[] } | null;
  objectStore?: ObjectStore | null;
  auditExportIntervalMs?: number;
  /** Run migrations at startup (default). Production runs `cli migrate` as the owner role instead. */
  migrate?: boolean;
  log?: BrokerLog;
}

export interface Cloud {
  db: Db;
  app: FastifyInstance;
  audit: CloudAudit;
  staff: StaffService;
  homes: HomesService;
  grants: GrantService;
  fleet: FleetService;
  notifications: Notifications;
  hubAudit: HubAuditStore;
  checkpoints: AuditCheckpoints;
  auditExport: AuditExport;
  push: StaffPush;
  signer: EnvelopeSigner | null;
  checkpointPublicKeyPem: string | null;
  broker: BrokerLink | null;
  /** Handles one message from hub `hubId` (what the broker link calls). */
  route(hubId: string, msg: HubMessage): Promise<void>;
  start(): Promise<void>;
  close(): Promise<void>;
}


/** Wires the cloud services together. The caller owns starting the HTTP listener. */
export async function createCloud(opts: CloudOptions): Promise<Cloud> {
  if (opts.migrate !== false) await migrate(opts.db);
  const audit = new CloudAudit(opts.db);
  const staff = new StaffService(opts.db, audit, opts.dataKey, opts.scryptCost);
  const homes = new HomesService(opts.db, audit);
  const notifications = new Notifications(opts.db, audit, opts.email ?? null);
  const hubAudit = new HubAuditStore(opts.db, audit);
  const signer = opts.commandKeyPem ? new EnvelopeSigner(opts.commandKeyPem) : null;
  const auditKey = opts.auditKeyPem ? new EnvelopeSigner(opts.auditKeyPem) : null;
  const checkpoints = new AuditCheckpoints(opts.db, audit, auditKey);
  const auditExport = new AuditExport(opts.db, audit, checkpoints, opts.objectStore ?? null);
  const push = new StaffPush(opts.db, opts.push?.sender ?? null, opts.push?.publicKey ?? null, opts.push?.allowedHosts);

  let broker: BrokerLink | null = null;
  const transport: HubTransport | null = opts.transport ?? {
    publish: (hubId, env) => {
      if (!broker) throw new Error('cloud broker not configured');
      return broker.publish(hubId, env);
    },
  };
  const linked = opts.broker || opts.transport ? transport : null;
  const grants = new GrantService(opts.db, audit, homes, notifications, signer, linked);
  const onboarding = new CustomerOnboarding(homes, audit, signer, transport);
  const fleet = new FleetService(opts.db, audit, signer, linked, opts.releasePublicKey ?? null);

  // Staff alerts when the owner decides or the session ends (best effort, never a gate).
  grants.onChange((g) => {
    const text: Partial<Record<typeof g.status, string>> = {
      active: 'The owner approved your support request.',
      rejected: `Your support request was not approved${g.endReason ? `: ${g.endReason}` : ''}.`,
      revoked: 'Support access was revoked.',
      expired: 'Support access has expired.',
    };
    const body = text[g.status];
    if (body) void push.notify(g.staff.staffId, { title: 'VOLTEX support access', body, url: `/home/?id=${g.homeId}#grants` }).catch(() => undefined);
  });

  const route = async (hubId: string, msg: HubMessage): Promise<void> => {
    if (!(await homes.homeOfHub(hubId))) return; // not a registered hub (the broker would not let it in)
    switch (msg.type) {
      case 'customer.ready':
      case 'customer.onboard.result':
        onboarding.handle(hubId, msg);
        return;
      case 'telemetry':
        return homes.recordTelemetry(hubId, msg.telemetry);
      case 'audit.batch':
        await hubAudit.ingest(hubId, msg.records);
        return;
      case 'update.status':
        return fleet.onUpdateStatus(hubId, msg);
      default:
        return grants.handleHubMessage(hubId, msg);
    }
  };
  // Background parts (broker link, audit export) log through the server's logger unless told
  // otherwise; it only exists once the API is built, and they only log after start().
  let appRef: FastifyInstance | undefined;
  const log: BrokerLog = opts.log ?? { info: (o, m) => appRef?.log.info(o, m), warn: (o, m) => appRef?.log.warn(o, m) };
  if (opts.broker) broker = new BrokerLink(opts.broker, route, log);

  const checkpointPublicKeyPem = auditKey?.publicKeyPem ?? null;
  const app = await buildCloudApi(
    {
      audit,
      staff,
      homes,
      config: { ...opts.api, commandPublicKeyPem: signer?.publicKeyPem },
      verifyAudit: () => checkpoints.verify(checkpointPublicKeyPem),
      plugins: [onboarding.routes(), supportRoutes({ grants, notifications, homes, hubAudit, checkpoints, push }), fleetRoutes(fleet)],
    },
    opts.server,
  );
  appRef = app;

  let exportTimer: NodeJS.Timeout | undefined;
  let retentionTimer: NodeJS.Timeout | undefined;
  return {
    db: opts.db,
    app,
    audit,
    staff,
    homes,
    grants,
    fleet,
    notifications,
    hubAudit,
    checkpoints,
    auditExport,
    push,
    signer,
    checkpointPublicKeyPem,
    broker,
    route,
    async start() {
      if (broker) await broker.start();
      grants.start();
      fleet.start();
      notifications.start();
      // Retention (docs/security/data-classification.md): dead sessions and setup links, hourly.
      retentionTimer = setInterval(() => void staff.purgeExpired().catch(() => undefined), 60 * 60_000);
      retentionTimer.unref();
      if (auditExport.enabled || auditKey) {
        const tick = async () => {
          if (auditExport.enabled) await auditExport.runAll();
          else await checkpoints.create();
        };
        exportTimer = setInterval(() => void tick().catch((err: Error) => log.warn({ err: err.message }, 'audit export failed')), opts.auditExportIntervalMs ?? 5 * 60_000);
        exportTimer.unref();
      }
    },
    async close() {
      clearInterval(exportTimer);
      clearInterval(retentionTimer);
      onboarding.close();
      grants.stop();
      fleet.stop();
      notifications.stop();
      opts.email?.close?.();
      await broker?.stop();
      await app.close();
      await opts.db.close();
    },
  };
}
