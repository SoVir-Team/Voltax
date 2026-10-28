// Display formatting. Times are always 12-hour (7:05 PM); cron and the hub use 24-hour internally.
import type { DeviceView } from './types';

export type Period = 'AM' | 'PM';
export interface Time12 {
  hour: number; // 1-12
  minute: number; // 0-59
  period: Period;
}

export const pretty = (s: string): string => s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** Rooms are devices: show the owner's name, or a tidy version of the device id. */
export const roomName = (d: Pick<DeviceView, 'name' | 'deviceId'>): string => (d.name === d.deviceId ? pretty(d.name) : d.name);

export const to24h = ({ hour, minute, period }: Time12) => ({ hour: (hour % 12) + (period === 'PM' ? 12 : 0), minute });

export const from24h = (hour24: number, minute: number): Time12 => ({
  hour: hour24 % 12 || 12,
  minute,
  period: hour24 < 12 ? 'AM' : 'PM',
});

export const formatTime12 = (hour24: number, minute: number): string => {
  const t = from24h(hour24, minute);
  return `${t.hour}:${String(t.minute).padStart(2, '0')} ${t.period}`;
};

/** A daily cron expression ("m h * * *") for a 12-hour time. */
export const dailyCron = (time: Time12): string => {
  const { hour, minute } = to24h(time);
  return `${minute} ${hour} * * *`;
};

export function cronLabel(cron: string): string {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(cron);
  return m ? `Every day at ${formatTime12(Number(m[2]), Number(m[1]))}` : cron;
}

export function since(ts: number | null, now = Date.now()): string {
  if (!ts) return 'never';
  const s = Math.round((now - ts) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return new Date(ts).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
}

export const formatPairingCode = (code: string): string => `${code.slice(0, 5)}-${code.slice(5)}`;

export function formatUptime(seconds: number): string {
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/** The room a device is shown under: the owner's room label, else the device name as before. */
export const roomOf = (d: Pick<DeviceView, 'name' | 'deviceId' | 'room'>): string => d.room ?? roomName(d);

export type DeviceFilter = 'all' | 'on' | 'off' | 'offline';

interface Findable {
  name: string;
  component: string;
  state: boolean | null;
  device: Pick<DeviceView, 'name' | 'deviceId' | 'room' | 'online'>;
}

/** Search matches the device name or its room; the filter looks at the reported state. */
export function matchesDevice(e: Findable, query: string, filter: DeviceFilter): boolean {
  const q = query.trim().toLowerCase();
  if (q && !`${pretty(e.name)} ${roomOf(e.device)}`.toLowerCase().includes(q)) return false;
  if (filter === 'offline') return !e.device.online;
  if (filter === 'on') return e.device.online && e.component === 'switch' && e.state === true;
  if (filter === 'off') return e.device.online && e.component === 'switch' && e.state !== true;
  return true;
}

/** Groups items by room, rooms in alphabetical order, keeping each room's item order. */
export function groupByRoom<T extends { device: Pick<DeviceView, 'name' | 'deviceId' | 'room'> }>(items: T[]): Array<[string, T[]]> {
  const rooms = new Map<string, T[]>();
  for (const item of items) {
    const room = roomOf(item.device);
    rooms.set(room, [...(rooms.get(room) ?? []), item]);
  }
  return [...rooms.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** Plain words for what a support grant allows (shown to the owner before approving). */
export const GRANT_ACTION_LABEL: Record<string, string> = {
  'device.command': 'Turn the chosen devices on and off',
  'diagnostics.read': 'See hub health (no device states or history)',
  'activity.read': 'See recent activity of the chosen devices',
  'hub.restart': 'Restart the hub',
};

/** "2 h 05 min" / "12 min" / "less than a minute" until `endsAt`. */
export function timeLeft(endsAt: number, now = Date.now()): string {
  const min = Math.floor((endsAt - now) / 60_000);
  if (min < 1) return 'less than a minute';
  return min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min` : `${min} min`;
}
