import { randomUUID } from 'node:crypto';
import type { AssignmentView, HomeView, PlatformRole, Telemetry } from '@voltax/contracts';
import type { CloudAudit } from './audit.js';
import { CLOUD_SERVICE_USER } from './broker.js';
import { newToken, safeEqualHex, sha256 } from './crypto.js';
import type { Db } from './db.js';
import { badRequest, conflict, notFound } from './errors.js';

/** A hub that has not reported for this long is shown offline. Telemetry arrives every minute. */
export const HUB_OFFLINE_AFTER_MS = 3 * 60_000;

interface HomeRow {
  id: string;
  name: string;
  owner_contact: string | null;
  created_at: number;
  hub_id: string | null;
  registered_at: number | null;
  last_seen_at: number | null;
  telemetry: string | null;
}

const HOME_SELECT = `SELECT homes.id, homes.name, homes.owner_contact, homes.created_at, hubs.hub_id, hubs.registered_at, hubs.last_seen_at, hubs.telemetry
  FROM homes LEFT JOIN hubs ON hubs.home_id = homes.id`;
const ACTIVE_ASSIGNMENT = 'a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at > $2)';

export class HomesService {
  constructor(
    private db: Db,
    private audit: CloudAudit,
  ) {}

  /** Platform scope sees every home; assigned scope sees only current assignments. */
  async list(staffId: string, scope: 'platform' | 'assigned'): Promise<HomeView[]> {
    const rows =
      scope === 'platform'
        ? await this.db.query<HomeRow>(`${HOME_SELECT} ORDER BY homes.created_at`)
        : await this.db.query<HomeRow>(
            `${HOME_SELECT} WHERE homes.id IN (SELECT a.home_id FROM assignments a WHERE a.staff_id = $1 AND ${ACTIVE_ASSIGNMENT}) ORDER BY homes.created_at`,
            [staffId, Date.now()],
          );
    return rows.map(homeView);
  }

  async get(homeId: string): Promise<HomeView> {
    return homeView(await this.row(homeId));
  }

  async contact(homeId: string): Promise<{ ownerContact: string | null }> {
    return { ownerContact: (await this.row(homeId)).owner_contact };
  }

  async exists(homeId: string): Promise<boolean> {
    return (await this.db.query('SELECT 1 FROM homes WHERE id = $1', [homeId])).length > 0;
  }

  async isAssigned(staffId: string, homeId: string): Promise<boolean> {
    const rows = await this.db.query(`SELECT 1 FROM assignments a WHERE a.staff_id = $1 AND a.home_id = $3 AND ${ACTIVE_ASSIGNMENT}`, [
      staffId,
      Date.now(),
      homeId,
    ]);
    return rows.length > 0;
  }

  async create(input: { name: string; ownerContact?: string | null }, by: string): Promise<HomeView> {
    const id = randomUUID();
    await this.db.query('INSERT INTO homes (id, name, owner_contact, created_at, created_by) VALUES ($1, $2, $3, $4, $5)', [
      id,
      input.name.trim(),
      input.ownerContact?.trim() || null,
      Date.now(),
      by,
    ]);
    await this.audit.append({ actor: `staff:${by}`, action: 'home.create', outcome: 'ok', target: `home:${id}`, homeId: id });
    return this.get(id);
  }

  /** Removes a home that never went live (clutter from mistakes and tests); its audit trail stays. */
  async remove(homeId: string, by: string): Promise<void> {
    const home = await this.row(homeId);
    if (home.last_seen_at !== null) throw conflict('This home has a hub that connected, so it cannot be deleted.');
    const [grant] = await this.db.query('SELECT 1 FROM grants WHERE home_id = $1 LIMIT 1', [homeId]);
    if (grant) throw conflict('This home has support access history, so it cannot be deleted.');
    await this.db.tx(async (t) => {
      await t.query('DELETE FROM assignments WHERE home_id = $1', [homeId]);
      await t.query('DELETE FROM hubs WHERE home_id = $1', [homeId]);
      await t.query('DELETE FROM homes WHERE id = $1', [homeId]);
    });
    await this.audit.append({ actor: `staff:${by}`, action: 'home.delete', outcome: 'ok', target: `home:${homeId}`, homeId, details: { name: home.name, hubId: home.hub_id } });
  }

  async update(homeId: string, patch: { name?: string; ownerContact?: string | null }, by: string): Promise<HomeView> {
    await this.row(homeId);
    if (patch.name !== undefined) await this.db.query('UPDATE homes SET name = $2 WHERE id = $1', [homeId, patch.name.trim()]);
    if (patch.ownerContact !== undefined) {
      await this.db.query('UPDATE homes SET owner_contact = $2 WHERE id = $1', [homeId, patch.ownerContact?.trim() || null]);
    }
    await this.audit.append({
      actor: `staff:${by}`,
      action: 'home.update',
      outcome: 'ok',
      target: `home:${homeId}`,
      homeId,
      details: { fields: Object.keys(patch) },
    });
    return this.get(homeId);
  }

  /**
   * Registers the home's hub on the cloud broker, or rotates its credential when called again with
   * the same hub id. The password is returned once and stored only as a hash.
   */
  async registerHub(homeId: string, hubId: string, by: string): Promise<{ hubId: string; brokerUsername: string; brokerPassword: string; rotated: boolean }> {
    if (hubId === CLOUD_SERVICE_USER) throw badRequest('this hub id is reserved');
    const home = await this.row(homeId);
    if (home.hub_id && home.hub_id !== hubId) throw conflict('this home already has a different hub registered');
    const [taken] = await this.db.query<{ home_id: string }>('SELECT home_id FROM hubs WHERE hub_id = $1', [hubId]);
    if (taken && taken.home_id !== homeId) throw conflict('this hub id belongs to another home');
    const password = newToken();
    const rotated = Boolean(home.hub_id);
    if (rotated) {
      await this.db.query('UPDATE hubs SET broker_secret_hash = $2 WHERE hub_id = $1', [hubId, sha256(password)]);
    } else {
      await this.db.query('INSERT INTO hubs (hub_id, home_id, broker_secret_hash, registered_at, registered_by) VALUES ($1, $2, $3, $4, $5)', [
        hubId,
        homeId,
        sha256(password),
        Date.now(),
        by,
      ]);
    }
    await this.audit.append({
      actor: `staff:${by}`,
      action: rotated ? 'hub.rotate_credential' : 'hub.register',
      outcome: 'ok',
      target: `hub:${hubId}`,
      homeId,
    });
    return { hubId, brokerUsername: hubId, brokerPassword: password, rotated };
  }

  async verifyHubSecret(hubId: string, password: string): Promise<boolean> {
    const [row] = await this.db.query<{ broker_secret_hash: string }>('SELECT broker_secret_hash FROM hubs WHERE hub_id = $1', [hubId]);
    return Boolean(row && safeEqualHex(row.broker_secret_hash, sha256(password)));
  }

  async hubOf(homeId: string): Promise<string | null> {
    const [row] = await this.db.query<{ hub_id: string }>('SELECT hub_id FROM hubs WHERE home_id = $1', [homeId]);
    return row?.hub_id ?? null;
  }

  async homeOfHub(hubId: string): Promise<string | null> {
    const [row] = await this.db.query<{ home_id: string }>('SELECT home_id FROM hubs WHERE hub_id = $1', [hubId]);
    return row?.home_id ?? null;
  }

  /** Stores the latest telemetry (already validated against the strict allow-list schema). */
  async recordTelemetry(hubId: string, telemetry: Telemetry): Promise<void> {
    await this.db.query('UPDATE hubs SET telemetry = $2, last_seen_at = $3 WHERE hub_id = $1', [hubId, JSON.stringify(telemetry), Date.now()]);
  }

  /** Device ids and online flags only, from the hub's allow-listed telemetry. */
  async devices(homeId: string): Promise<Array<{ deviceId: string; online: boolean }>> {
    const t = parseTelemetry((await this.row(homeId)).telemetry);
    return t?.devices.map((d) => ({ deviceId: d.deviceId, online: d.online })) ?? [];
  }

  async listAssignments(filter: { staffId?: string; homeId?: string }): Promise<AssignmentView[]> {
    const rows = await this.db.query<{ id: string; staff_id: string; home_id: string; created_at: number; created_by: string; expires_at: number | null }>(
      `SELECT * FROM assignments a WHERE ${ACTIVE_ASSIGNMENT.replace('$2', '$1')}
         AND ($2::uuid IS NULL OR a.staff_id = $2) AND ($3::uuid IS NULL OR a.home_id = $3) ORDER BY a.created_at`,
      [Date.now(), filter.staffId ?? null, filter.homeId ?? null],
    );
    return rows.map((r) => ({
      assignmentId: r.id,
      staffId: r.staff_id,
      homeId: r.home_id,
      createdAt: Number(r.created_at),
      createdBy: r.created_by,
      expiresAt: r.expires_at === null ? null : Number(r.expires_at),
    }));
  }

  async assign(input: { staffId: string; homeId: string; expiresAt?: number | null }, by: string): Promise<AssignmentView> {
    const [staff] = await this.db.query<{ role: PlatformRole; disabled_at: number | null }>('SELECT role, disabled_at FROM staff WHERE id = $1', [input.staffId]);
    if (!staff) throw notFound();
    await this.row(input.homeId);
    // Super admins work at platform scope and never hold household assignments.
    if (staff.role === 'PLATFORM_SUPER_ADMIN') throw badRequest('only support staff and installers are assigned to homes');
    if (staff.disabled_at) throw badRequest('this staff account is disabled');
    if (input.expiresAt != null && input.expiresAt <= Date.now()) throw badRequest('expiry must be in the future');
    const id = randomUUID();
    await this.db.tx(async (t) => {
      const now = Date.now();
      // Replace an existing (possibly expired) assignment for the same pair.
      await t.query('UPDATE assignments SET revoked_at = $3 WHERE staff_id = $1 AND home_id = $2 AND revoked_at IS NULL', [input.staffId, input.homeId, now]);
      await t.query('INSERT INTO assignments (id, staff_id, home_id, created_by, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6)', [
        id,
        input.staffId,
        input.homeId,
        by,
        now,
        input.expiresAt ?? null,
      ]);
    });
    await this.audit.append({
      actor: `staff:${by}`,
      action: 'assignment.create',
      outcome: 'ok',
      target: `staff:${input.staffId}`,
      homeId: input.homeId,
      details: { expiresAt: input.expiresAt ?? null },
    });
    return (await this.listAssignments({ staffId: input.staffId, homeId: input.homeId }))[0]!;
  }

  async unassign(assignmentId: string, by: string): Promise<void> {
    const [row] = await this.db.query<{ staff_id: string; home_id: string }>(
      'UPDATE assignments SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING staff_id, home_id',
      [assignmentId, Date.now()],
    );
    if (!row) throw notFound();
    await this.audit.append({ actor: `staff:${by}`, action: 'assignment.revoke', outcome: 'ok', target: `staff:${row.staff_id}`, homeId: row.home_id });
  }

  private async row(homeId: string): Promise<HomeRow> {
    const [row] = await this.db.query<HomeRow>(`${HOME_SELECT} WHERE homes.id = $1`, [homeId]);
    if (!row) throw notFound();
    return row;
  }
}

export function parseTelemetry(raw: string | null): Telemetry | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Telemetry;
  } catch {
    return null;
  }
}

function homeView(r: HomeRow): HomeView {
  const t = parseTelemetry(r.telemetry);
  const lastSeen = r.last_seen_at === null ? null : Number(r.last_seen_at);
  return {
    homeId: r.id,
    name: r.name,
    createdAt: Number(r.created_at),
    hub: r.hub_id
      ? {
          hubId: r.hub_id,
          registeredAt: Number(r.registered_at),
          lastSeenAt: lastSeen,
          online: lastSeen !== null && Date.now() - lastSeen < HUB_OFFLINE_AFTER_MS,
          version: t?.version ?? null,
          timeSynced: t?.timeSynced ?? null,
          update: t?.update ?? null,
          devicesOnline: t?.devices.filter((d) => d.online).length ?? 0,
          devicesTotal: t?.devices.length ?? 0,
        }
      : null,
  };
}
