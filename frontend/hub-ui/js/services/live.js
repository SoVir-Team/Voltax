// Live connection to the hub: WebSocket events, refreshes and device commands.
import { api, API, uuid } from '../core/api.js';
import { toast } from '../core/dom.js';
import { pretty } from '../core/format.js';
import { findEntity, state } from '../core/state.js';
import { render, renderLive } from '../router.js';
import { signOut } from './session.js';

export function setConn(next) {
  state.conn = next;
  const el = document.getElementById('conn');
  el.dataset.state = next;
  el.lastElementChild.textContent = { live: 'Local · Live', connecting: 'Connecting', offline: 'Hub unreachable' }[next];
}

export async function sendCommand(entityId, value, switchEl) {
  if (state.pending.has(entityId)) return;
  const commandId = uuid();
  state.pending.set(entityId, commandId);
  render();
  try {
    const { status, data } = await api(`/entities/${encodeURIComponent(entityId)}/commands`, { method: 'POST', body: { commandId, value } });
    if (status === 410) throw new Error('Command expired before it could run');
    if (data && data.status !== 'pending' && data.status !== 'sent') settleCommand(data);
  } catch (err) {
    state.pending.delete(entityId);
    toast(err.message, 'error');
    render();
    switchEl?.classList.add('shake');
  }
}

function settleCommand(cmd) {
  if (state.pending.get(cmd.entityId) !== cmd.commandId) return;
  if (cmd.status === 'pending' || cmd.status === 'sent') return;
  state.pending.delete(cmd.entityId);
  if (cmd.status !== 'confirmed') {
    const name = pretty(findEntity(cmd.entityId)?.name ?? cmd.entityId);
    toast(`${name}: ${cmd.reason ?? cmd.status}`, 'error');
  }
  renderLive();
  if (cmd.status !== 'confirmed') document.querySelector(`[data-entity="${CSS.escape(cmd.entityId)}"] .switch`)?.classList.add('shake');
}

function applyEvent(ev) {
  state.lastSeq = Math.max(state.lastSeq, ev.seq);
  const p = ev.payload;
  if (ev.type === 'entity.state') {
    let entity;
    for (const d of state.devices) entity ??= d.entities.find((e) => e.entityId === p.entityId);
    if (!entity) return void refresh();
    entity.state = p.state;
    entity.stateVersion = p.stateVersion;
    entity.updatedAt = ev.createdAt;
    renderLive();
  } else if (ev.type === 'device.online') {
    const d = state.devices.find((x) => x.deviceId === p.deviceId);
    if (!d) return void refresh();
    d.online = p.online;
    d.lastSeen = ev.createdAt;
    renderLive();
  } else if (ev.type === 'command.status') {
    settleCommand(p);
  }
}

export function connectWs() {
  if (!state.token) return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${API}/ws`);
  state.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: state.token, resumeAfterSeq: state.lastSeq || undefined }));
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.type === 'ready') {
      state.wsRetry = 0;
      setConn('live');
    } else if (msg.type === 'event') applyEvent(msg.event);
  };
  ws.onclose = (e) => {
    if (state.ws !== ws) return;
    if (e.code === 4401 || e.code === 4403) return signOut('Your access was removed. Pair again to continue.');
    setConn(state.wsRetry > 1 ? 'offline' : 'connecting');
    const delay = Math.min(15000, 500 * 2 ** state.wsRetry++);
    setTimeout(() => refresh().finally(connectWs), delay);
  };
}

export async function refresh() {
  try {
    const [devices, health] = await Promise.all([api('/devices'), api('/health')]);
    state.devices = devices.data;
    state.health = health.data;
    renderLive();
  } catch (err) {
    if (err.message !== 'unauthorized') setConn('offline');
  }
}
