'use client';

import { useState, type FormEvent } from 'react';
import { pretty, roomName } from '@/lib/format';
import { useHub, type EntityWithDevice } from '@/providers/HubProvider';
import { useToast } from '@/providers/ToastProvider';

/** Owner-only: rename the device and its room (stored on the hub). */
export function RenameForm({ entity }: { entity: EntityWithDevice }) {
  const { api, refresh } = useHub();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(pretty(entity.name));
  const [room, setRoom] = useState(roomName(entity.device));

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      await api(`/entities/${encodeURIComponent(entity.entityId)}`, { method: 'PATCH', body: { name } });
      await api(`/devices/${encodeURIComponent(entity.deviceId)}`, { method: 'PATCH', body: { name: room } });
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
              <input value={room} maxLength={64} required onChange={(e) => setRoom(e.target.value)} />
            </label>
          </div>
          <button className="btn sm" type="submit">
            Save
          </button>
        </form>
      ) : (
        <button className="btn ghost sm" type="button" onClick={() => setOpen(true)}>
          Rename
        </button>
      )}
    </div>
  );
}
