'use client';

import { roomOf } from '@/lib/format';
import type { DeviceGrantInput } from '@/lib/types';
import { useHub } from '@/providers/HubProvider';

/** Which devices a member may see and control: every device (including future ones) or a chosen few. */
export function DevicePicker({ value, onChange }: { value: DeviceGrantInput; onChange(v: DeviceGrantInput): void }) {
  const { devices } = useHub();
  const all = value === '*';
  const chosen = new Set(all ? [] : value);
  const toggle = (id: string) => onChange(chosen.has(id) ? [...chosen].filter((d) => d !== id) : [...chosen, id]);

  return (
    <fieldset className="picker">
      <legend>Devices they can use</legend>
      <label className="check">
        <input type="checkbox" checked={all} onChange={(e) => onChange(e.target.checked ? '*' : [])} />
        <span>
          All devices <span className="muted small">(including ones added later)</span>
        </span>
      </label>
      {!all && (
        <div className="picker-list">
          {devices.length === 0 && <p className="small muted">No devices on the hub yet.</p>}
          {[...devices]
            .sort((a, b) => roomOf(a).localeCompare(roomOf(b)))
            .map((d) => (
              <label className="check" key={d.deviceId}>
                <input type="checkbox" checked={chosen.has(d.deviceId)} onChange={() => toggle(d.deviceId)} />
                <span>
                  {roomOf(d)} <span className="muted small">· {d.entities.length} {d.entities.length === 1 ? 'control' : 'controls'}</span>
                </span>
              </label>
            ))}
          {chosen.size === 0 && <p className="small muted">Nothing chosen: they will see no devices until you add some.</p>}
        </div>
      )}
    </fieldset>
  );
}
