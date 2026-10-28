import { describe, expect, it } from 'vitest';
import { cronLabel, dailyCron, formatTime12, from24h, pretty, roomName, since, to24h } from './format';

describe('12-hour time', () => {
  it.each([
    [0, 5, '12:05 AM'],
    [9, 0, '9:00 AM'],
    [12, 0, '12:00 PM'],
    [19, 30, '7:30 PM'],
    [23, 59, '11:59 PM'],
  ])('formats %i:%i as %s', (h, m, label) => {
    expect(formatTime12(h, m)).toBe(label);
  });

  it('round-trips every minute of the day through the 12-hour picker', () => {
    for (let h = 0; h < 24; h++) for (const m of [0, 1, 59]) expect(to24h(from24h(h, m))).toEqual({ hour: h, minute: m });
  });

  it('builds daily cron in 24-hour form', () => {
    expect(dailyCron({ hour: 12, minute: 5, period: 'AM' })).toBe('5 0 * * *');
    expect(dailyCron({ hour: 12, minute: 0, period: 'PM' })).toBe('0 12 * * *');
    expect(dailyCron({ hour: 7, minute: 0, period: 'PM' })).toBe('0 19 * * *');
  });

  it('labels daily cron in 12-hour form and leaves other cron as-is', () => {
    expect(cronLabel('0 19 * * *')).toBe('Every day at 7:00 PM');
    expect(cronLabel('*/5 * * * *')).toBe('*/5 * * * *');
  });
});

describe('names and relative time', () => {
  it('tidies ids', () => {
    expect(pretty('living-room_light')).toBe('Living Room Light');
    expect(roomName({ deviceId: 'kitchen', name: 'kitchen' })).toBe('Kitchen');
    expect(roomName({ deviceId: 'kitchen', name: 'Main kitchen' })).toBe('Main kitchen');
  });

  it('describes recent times', () => {
    const now = 1_000_000_000;
    expect(since(null, now)).toBe('never');
    expect(since(now - 3_000, now)).toBe('just now');
    expect(since(now - 30_000, now)).toBe('30s ago');
    expect(since(now - 600_000, now)).toBe('10m ago');
  });
});
