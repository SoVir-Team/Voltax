// MQTT topic contract. Matches ESPHome's MQTT layout with
// topic_prefix = voltax/<hubId>/<deviceId>:
//   <prefix>/status                          "online" | "offline" (birth / last will)
//   <prefix>/<component>/<objectId>/state    "ON" | "OFF"          (retained, device -> hub)
//   <prefix>/<component>/<objectId>/command  "ON" | "OFF"          (never retained, hub -> device)

export const TOPIC_ROOT = 'voltax';

const SEGMENT = /^[a-z0-9_-]+$/i;

export type Component = 'switch' | 'binary_sensor';

export interface EntityRef {
  deviceId: string;
  component: Component;
  objectId: string;
}

export type ParsedTopic =
  | { kind: 'status'; hubId: string; deviceId: string }
  | ({ kind: 'state' | 'command'; hubId: string } & EntityRef);

/** Entity IDs look like `esp-relay-01.switch.relay_1`. */
export function entityId(ref: EntityRef): string {
  return `${ref.deviceId}.${ref.component}.${ref.objectId}`;
}

export function parseEntityId(id: string): EntityRef | null {
  const [deviceId, component, objectId, ...rest] = id.split('.');
  if (rest.length || !deviceId || !objectId || !isComponent(component)) return null;
  if (!SEGMENT.test(deviceId) || !SEGMENT.test(objectId)) return null;
  return { deviceId, component, objectId };
}

export function deviceTopic(hubId: string, deviceId: string): string {
  return `${TOPIC_ROOT}/${hubId}/${deviceId}`;
}

export function statusTopic(hubId: string, deviceId: string): string {
  return `${deviceTopic(hubId, deviceId)}/status`;
}

export function stateTopic(hubId: string, ref: EntityRef): string {
  return `${deviceTopic(hubId, ref.deviceId)}/${ref.component}/${ref.objectId}/state`;
}

export function commandTopic(hubId: string, ref: EntityRef): string {
  return `${deviceTopic(hubId, ref.deviceId)}/${ref.component}/${ref.objectId}/command`;
}

/** Wildcard subscriptions the hub needs. */
export function hubSubscriptions(hubId: string): string[] {
  return [`${TOPIC_ROOT}/${hubId}/+/status`, `${TOPIC_ROOT}/${hubId}/+/+/+/state`];
}

export function parseTopic(topic: string): ParsedTopic | null {
  const parts = topic.split('/');
  if (parts[0] !== TOPIC_ROOT) return null;
  const [, hubId, deviceId] = parts;
  if (!hubId || !deviceId) return null;
  if (parts.length === 4 && parts[3] === 'status') return { kind: 'status', hubId, deviceId };
  if (parts.length === 6) {
    const [, , , component, objectId, kind] = parts;
    if (!isComponent(component) || !objectId) return null;
    if (kind === 'state' || kind === 'command') return { kind, hubId, deviceId, component, objectId };
  }
  return null;
}

export function payloadToBool(payload: string): boolean | null {
  const p = payload.trim().toUpperCase();
  if (p === 'ON') return true;
  if (p === 'OFF') return false;
  return null;
}

export function boolToPayload(value: boolean): 'ON' | 'OFF' {
  return value ? 'ON' : 'OFF';
}

function isComponent(c: string | undefined): c is Component {
  return c === 'switch' || c === 'binary_sensor';
}
