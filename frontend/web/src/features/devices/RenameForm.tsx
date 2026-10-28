'use client';

import { useState, type FormEvent } from 'react';
import { pretty } from '@/lib/format';
import { useHub, type EntityWithDevice } from '@/providers/HubProvider';
import { useToast } from '@/providers/ToastProvider';

/** Owner-only: rename the control and choose its device's room (both stored on the hub). */
export function RenameForm({ entity }: { entity: EntityWithDevice }) {
  const { api, refresh, devices } = useHub();
  const rooms = [...new Set(devices.map((d) => d.room).filter((r): r is string => !!r))].sort();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(pretty(entity.name));
  const [room, setRoom] = useState(entity.device.room ?? '');

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      await api(`/entities/${encodeURIComponent(entity.entityId)}`, { method: 'PATCH', body: { name } });
      await api(`/devices/${encodeURIComponent(entity.deviceId)}/room`, { method: 'PUT', body: { room: room.trim() || null } });
      toast('Saved');
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }

  return (
    <div style={{ display: 'grid', justifyItems: 'center', gap: 10, marginTop: 6 }}>
      {open ? (
        <form className="form" onSubmit={save}>
          <div className="form-row">
            <label className="field">
              Name
              <input value={name} maxLength={64} required autoFocus onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              Room
              <input value={room} maxLength={40} placeholder="e.g. Kitchen" list="voltax-rooms" onChange={(e) => setRoom(e.target.value)} />
              <datalist id="voltax-rooms">
                {rooms.map((r) => (
                  <option key={r} value={r} />
                ))}
              </datalist>
            </label>
          </div>
          <button className="btn sm" type="submit">
            Save
          </button>
        </form>
      ) : (
        <button className="btn ghost sm" type="button" onClick={() => setOpen(true)}>
          Rename or move to a room
        </button>
      )}
    </div>
  );
}
