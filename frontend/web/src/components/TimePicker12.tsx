'use client';

import type { Period, Time12 } from '@/lib/format';

const HOURS = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const MINUTES = Array.from({ length: 60 }, (_, i) => i);

/** Always 12-hour. A native <input type="time"> follows the device locale, which is often 24-hour. */
export function TimePicker12({ value, onChange }: { value: Time12; onChange(next: Time12): void }) {
  return (
    <div className="time-picker">
      <select aria-label="Hour" value={value.hour} onChange={(e) => onChange({ ...value, hour: Number(e.target.value) })}>
        {HOURS.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </select>
      <select aria-label="Minute" value={value.minute} onChange={(e) => onChange({ ...value, minute: Number(e.target.value) })}>
        {MINUTES.map((m) => (
          <option key={m} value={m}>
            {String(m).padStart(2, '0')}
          </option>
        ))}
      </select>
      <select aria-label="AM or PM" value={value.period} onChange={(e) => onChange({ ...value, period: e.target.value as Period })}>
        <option value="AM">AM</option>
        <option value="PM">PM</option>
      </select>
    </div>
  );
}
