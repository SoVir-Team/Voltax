import { describe, expect, it } from 'vitest';
import { cronLabel, dailyCron, formatTime12, from24h, groupByRoom, matchesDevice, pretty, roomName, roomOf, since, timeLeft, to24h } from './format';

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

describe('rooms, search and filters', () => {
  const dev = (deviceId: string, room: string | null, online = true) => ({ deviceId, name: deviceId, room, online });
  const e = (name: string, device: ReturnType<typeof dev>, state: boolean | null = false, component = 'switch') => ({ name, component, state, device });

  it('uses the room label when set, the device name otherwise', () => {
    expect(roomOf(dev('esp-relay-01', 'Kitchen'))).toBe('Kitchen');
    expect(roomOf(dev('esp-relay-01', null))).toBe('Esp Relay 01');
  });

  it('searches names and rooms, and filters by reported state', () => {
    const lamp = e('relay_1', dev('a', 'Living room'), true);
    const fan = e('fan', dev('b', 'Bedroom', false), false);
    expect(matchesDevice(lamp, 'living', 'all')).toBe(true);
    expect(matchesDevice(lamp, 'RELAY', 'all')).toBe(true);
    expect(matchesDevice(fan, 'living', 'all')).toBe(false);
    expect(matchesDevice(lamp, '', 'on')).toBe(true);
    expect(matchesDevice(lamp, '', 'off')).toBe(false);
    expect(matchesDevice(fan, '', 'offline')).toBe(true);
    expect(matchesDevice(fan, '', 'off')).toBe(false); // offline is not "off": the state is unknown
  });

  it('groups by room in alphabetical order, several devices per room', () => {
    const items = [e('x', dev('a', 'Kitchen')), e('y', dev('b', 'Bedroom')), e('z', dev('c', 'Kitchen'))];
    expect(groupByRoom(items).map(([room, list]) => [room, list.map((i) => i.name)])).toEqual([
      ['Bedroom', ['y']],
      ['Kitchen', ['x', 'z']],
    ]);
  });

  it('time left on a support session', () => {
    expect(timeLeft(125 * 60_000, 0)).toBe('2 h 05 min');
    expect(timeLeft(12 * 60_000 + 5, 0)).toBe('12 min');
    expect(timeLeft(30_000, 0)).toBe('less than a minute');
  });
});
