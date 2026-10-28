import { entityId as toEntityId, type DeviceView, type EntityRef, type EntityView } from '@voltax/contracts';
import type { DB } from './db.js';

interface EntityRow {
  entity_id: string;
  device_id: string;
  component: 'switch' | 'binary_sensor';
  name: string;
  state: number | null;
  state_version: number;
  updated_at: number | null;
}

interface DeviceRow {
  device_id: string;
  name: string;
  online: number;
  last_seen: number | null;
}

/** Devices and their last REPORTED entity states. Only device reports change state here. */
export class Store {
  constructor(private db: DB) {}

  ensureDevice(deviceId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO devices (device_id, name) VALUES (?, ?)').run(deviceId, deviceId);
  }

  /** Returns true when the online flag actually changed. */
  setDeviceOnline(deviceId: string, online: boolean, now = Date.now()): boolean {
    this.ensureDevice(deviceId);
    const before = this.db.prepare('SELECT online FROM devices WHERE device_id = ?').get(deviceId) as { online: number };
    this.db.prepare('UPDATE devices SET online = ?, last_seen = ? WHERE device_id = ?').run(online ? 1 : 0, now, deviceId);
    return before.online !== (online ? 1 : 0);
  }

  isDeviceOnline(deviceId: string): boolean {
    const row = this.db.prepare('SELECT online FROM devices WHERE device_id = ?').get(deviceId) as { online: number } | undefined;
    return row?.online === 1;
  }

  /** Record a reported state. `changed` is false for duplicates (e.g. QoS 1 redelivery). */
  reportState(ref: EntityRef, value: boolean, now = Date.now()): { changed: boolean; entity: EntityView } {
    const id = toEntityId(ref);
    return this.db.transaction(() => {
      this.ensureDevice(ref.deviceId);
      this.db.prepare('UPDATE devices SET last_seen = ? WHERE device_id = ?').run(now, ref.deviceId);
      this.db
        .prepare('INSERT OR IGNORE INTO entities (entity_id, device_id, component, name) VALUES (?, ?, ?, ?)')
        .run(id, ref.deviceId, ref.component, ref.objectId);
      const before = this.getEntity(id)!;
      const changed = before.state !== value;
      this.db
        .prepare('UPDATE entities SET state = ?, state_version = state_version + ?, updated_at = ? WHERE entity_id = ?')
        .run(value ? 1 : 0, changed ? 1 : 0, now, id);
      return { changed, entity: this.getEntity(id)! };
    })();
  }

  getEntity(id: string): EntityView | null {
    const row = this.db.prepare('SELECT * FROM entities WHERE entity_id = ?').get(id) as EntityRow | undefined;
    return row ? toEntityView(row) : null;
  }

  listDevices(): DeviceView[] {
    const devices = this.db.prepare('SELECT * FROM devices ORDER BY device_id').all() as DeviceRow[];
    const entities = this.db.prepare('SELECT * FROM entities ORDER BY entity_id').all() as EntityRow[];
    return devices.map((d) => ({
      deviceId: d.device_id,
      name: d.name,
      online: d.online === 1,
      lastSeen: d.last_seen,
      entities: entities.filter((e) => e.device_id === d.device_id).map(toEntityView),
    }));
  }

  renameDevice(deviceId: string, name: string): boolean {
    return this.db.prepare('UPDATE devices SET name = ? WHERE device_id = ?').run(name, deviceId).changes > 0;
  }

  renameEntity(id: string, name: string): boolean {
    return this.db.prepare('UPDATE entities SET name = ? WHERE entity_id = ?').run(name, id).changes > 0;
  }

  deleteDevice(deviceId: string): boolean {
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM entities WHERE device_id = ?').run(deviceId);
      return this.db.prepare('DELETE FROM devices WHERE device_id = ?').run(deviceId).changes > 0;
    })();
  }
}

function toEntityView(r: EntityRow): EntityView {
  return {
    entityId: r.entity_id,
    deviceId: r.device_id,
    component: r.component,
    name: r.name,
    state: r.state === null ? null : r.state === 1,
    stateVersion: r.state_version,
    updatedAt: r.updated_at,
  };
}
