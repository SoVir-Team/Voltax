// Display formatting. Times are always 12-hour (7:05 PM); cron and the hub use 24-hour internally.

export const pretty = (s) => s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// Rooms are devices: show the owner's name, or a tidy version of the device id.
export const roomName = (d) => (d.name === d.deviceId ? pretty(d.name) : d.name);

export const time12 = (h24, m) => `${h24 % 12 || 12}:${String(m).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`;

export const since = (ts) => {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return new Date(ts).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
};

export function cronLabel(cron) {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(cron);
  return m ? `Every day at ${time12(Number(m[2]), Number(m[1]))}` : cron;
}
