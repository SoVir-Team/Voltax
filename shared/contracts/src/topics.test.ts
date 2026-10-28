import { describe, expect, it } from 'vitest';
import { commandTopic, entityId, parseEntityId, parseTopic, payloadToBool, stateTopic } from './topics.js';

const ref = { deviceId: 'esp-relay-01', component: 'switch', objectId: 'relay_1' } as const;

describe('topics', () => {
  it('builds ESPHome-compatible state and command topics', () => {
    expect(stateTopic('hub1', ref)).toBe('voltax/hub1/esp-relay-01/switch/relay_1/state');
    expect(commandTopic('hub1', ref)).toBe('voltax/hub1/esp-relay-01/switch/relay_1/command');
  });

  it('round-trips entity ids', () => {
    expect(parseEntityId(entityId(ref))).toEqual(ref);
    expect(parseEntityId('bad')).toBeNull();
    expect(parseEntityId('a.light.b')).toBeNull();
  });

  it('parses state and status topics, rejects others', () => {
    expect(parseTopic('voltax/hub1/esp-relay-01/switch/relay_1/state')).toEqual({ kind: 'state', hubId: 'hub1', ...ref });
    expect(parseTopic('voltax/hub1/esp-relay-01/status')).toEqual({ kind: 'status', hubId: 'hub1', deviceId: 'esp-relay-01' });
    expect(parseTopic('other/hub1/x/status')).toBeNull();
    expect(parseTopic('voltax/hub1/x/light/y/state')).toBeNull();
  });

  it('maps payloads', () => {
    expect(payloadToBool('ON')).toBe(true);
    expect(payloadToBool('off')).toBe(false);
    expect(payloadToBool('42')).toBeNull();
  });
});
