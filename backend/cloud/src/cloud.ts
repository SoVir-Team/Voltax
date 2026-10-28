import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import { buildCloudApi, type CloudApiConfig } from './api.js';
import { CloudAudit } from './audit.js';
import type { ScryptCost } from './crypto.js';
import { migrate, type Db } from './db.js';
import { HomesService } from './homes.js';
import { StaffService } from './staff.js';

export interface CloudOptions {
  db: Db;
  dataKey: Buffer;
  /** Ed25519 private key (PEM) that signs envelopes to hubs. Absent = no remote support actions. */
  commandKeyPem?: string;
  api: CloudApiConfig;
  scryptCost?: ScryptCost;
  server?: FastifyServerOptions;
}

export interface Cloud {
  db: Db;
  app: FastifyInstance;
  audit: CloudAudit;
  staff: StaffService;
  homes: HomesService;
  close(): Promise<void>;
}

/** Wires the cloud services together. The caller owns starting the HTTP listener. */
export async function createCloud(opts: CloudOptions): Promise<Cloud> {
  await migrate(opts.db);
  const audit = new CloudAudit(opts.db);
  const staff = new StaffService(opts.db, audit, opts.dataKey, opts.scryptCost);
  const homes = new HomesService(opts.db, audit);
  const app = await buildCloudApi({ audit, staff, homes, config: opts.api }, opts.server);
  return {
    db: opts.db,
    app,
    audit,
    staff,
    homes,
    async close() {
      await app.close();
      await opts.db.close();
    },
  };
}
