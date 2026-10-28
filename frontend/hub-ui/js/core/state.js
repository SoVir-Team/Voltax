// App state shared by every screen. It holds what the DEVICES REPORTED, never what we asked for.

export const STORAGE = {
  token: 'voltax.token',
  role: 'voltax.role',
  clientId: 'voltax.clientId',
  installDismissed: 'voltax.installDismissed',
};

export const state = {
  token: localStorage.getItem(STORAGE.token),
  role: localStorage.getItem(STORAGE.role),
  clientId: localStorage.getItem(STORAGE.clientId),
  hub: null,
  health: null,
  devices: [],
  pending: new Map(), // entityId -> commandId awaiting confirmation
  lastSeq: 0,
  ws: null,
  wsRetry: 0,
  conn: 'connecting',
};

export const allEntities = () => state.devices.flatMap((d) => d.entities.map((e) => ({ ...e, device: d })));
export const findEntity = (id) => allEntities().find((e) => e.entityId === id);
export const isOwner = () => state.role === 'owner';
