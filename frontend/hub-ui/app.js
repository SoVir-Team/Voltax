// VOLTEX hub UI. Talks only to the local hub API (/api/v1) and its WebSocket.
// It always renders the state the DEVICE REPORTED, never the state it asked for.

const API = '/api/v1';
const TOKEN_KEY = 'voltax.token';
const ROLE_KEY = 'voltax.role';
const CLIENT_KEY = 'voltax.clientId';

const state = {
  token: localStorage.getItem(TOKEN_KEY),
  role: localStorage.getItem(ROLE_KEY),
  clientId: localStorage.getItem(CLIENT_KEY),
  hub: null,
  health: null,
  devices: [],
  pending: new Map(), // entityId -> commandId awaiting confirmation
  lastSeq: 0,
  ws: null,
  wsRetry: 0,
  conn: 'connecting',
};

// ---------- tiny safe DOM helper (never uses innerHTML for data) ----------
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v; // only ever used with static SVG constants below
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

const ICONS = {
  bulb: '<svg viewBox="0 0 24 24"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1.1 2V16h5v-.2c.1-.8.5-1.5 1.1-2A6 6 0 0 0 12 3z"/></svg>',
  sensor: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2.5"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  bolt: '<svg viewBox="0 0 24 24"><path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M15 5l-7 7 7 7"/></svg>',
};
const icon = (name, cls = 'tile-icon') => h('span', { class: cls, html: ICONS[name], 'aria-hidden': 'true' });

// ---------- API ----------
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(state.token ? { authorization: `Bearer ${state.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && state.token) {
    signOut('Your access was removed. Pair again to continue.');
    throw new Error('unauthorized');
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok && res.status !== 410) throw Object.assign(new Error(data?.error ?? `Request failed (${res.status})`), { status: res.status });
  return { status: res.status, data };
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

// ---------- feedback ----------
let toastTimer;
function toast(message, kind = 'info') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3200);
}

function setConn(next) {
  state.conn = next;
  const el = document.getElementById('conn');
  el.dataset.state = next;
  el.lastElementChild.textContent = { live: 'Local · Live', connecting: 'Connecting', offline: 'Hub unreachable' }[next];
}

// ---------- entity helpers ----------
const allEntities = () => state.devices.flatMap((d) => d.entities.map((e) => ({ ...e, device: d })));
const findEntity = (id) => allEntities().find((e) => e.entityId === id);
const pretty = (s) => s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
// Rooms are devices: show the owner's name, or a tidy version of the device id.
const roomName = (d) => (d.name === d.deviceId ? pretty(d.name) : d.name);
const since = (ts) => {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return new Date(ts).toLocaleString();
};

async function sendCommand(entityId, value, switchEl) {
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

// ---------- live events ----------
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

function connectWs() {
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

async function refresh() {
  try {
    const [devices, health] = await Promise.all([api('/devices'), api('/health')]);
    state.devices = devices.data;
    state.health = health.data;
    renderLive();
  } catch (err) {
    if (err.message !== 'unauthorized') setConn('offline');
  }
}

function signOut(message) {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ROLE_KEY);
  localStorage.removeItem(CLIENT_KEY);
  state.token = null;
  state.role = null;
  const ws = state.ws;
  state.ws = null;
  ws?.close();
  if (message) toast(message, 'error');
  render();
}

// ---------- views ----------
function viewPair() {
  const code = h('input', { class: 'code-input', id: 'code', autocomplete: 'one-time-code', maxlength: '11', placeholder: 'XXXXX-XXXXX', required: true });
  const name = h('input', { id: 'name', maxlength: '64', placeholder: 'e.g. Priya’s iPhone', required: true });
  const submit = h('button', { class: 'btn block', type: 'submit' }, 'Connect to hub');
  const form = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault();
    submit.disabled = true;
    try {
      const { data } = await api('/pair', { method: 'POST', body: { pairingCode: code.value, clientName: name.value } });
      state.token = data.token;
      state.role = data.role;
      localStorage.setItem(TOKEN_KEY, data.token);
      localStorage.setItem(ROLE_KEY, data.role);
      localStorage.setItem(CLIENT_KEY, data.clientId);
      state.clientId = data.clientId;
      toast('Connected to your VOLTEX hub');
      start();
    } catch (err) {
      toast(err.status === 429 ? 'Too many attempts. Wait 15 minutes and try again.' : 'That code is invalid or has expired.', 'error');
      code.select();
    } finally {
      submit.disabled = false;
    }
  } },
    h('label', { class: 'field', for: 'code' }, 'Pairing code', code),
    h('label', { class: 'field', for: 'name' }, 'Name this device', name),
    submit,
  );
  return h('div', { class: 'pair' },
    h('div', { class: 'card pair-card' },
      h('img', { src: 'logo.svg', alt: 'VOLTEX' }),
      h('h1', { class: 'title' }, 'Connect to your home'),
      h('p', { class: 'muted' }, `Enter the one-time code from your installer or from the owner’s app. Codes expire after a few minutes and work once.`),
      state.hub ? h('p', { class: 'small muted' }, `Hub ${state.hub.name} · ${state.hub.hubId}`) : null,
      form,
    ),
  );
}

function switchFor(entity) {
  const pending = state.pending.has(entity.entityId);
  return h('button', {
    class: 'switch', role: 'switch', type: 'button',
    'aria-checked': String(entity.state === true),
    'aria-label': `${pretty(entity.name)} power`,
    'data-pending': pending ? 'true' : null,
    disabled: !entity.device.online || pending ? true : null,
    onclick: (e) => { e.stopPropagation(); void sendCommand(entity.entityId, entity.state !== true, e.currentTarget); },
    onanimationend: (e) => e.currentTarget.classList.remove('shake'),
  });
}

function deviceTile(entity) {
  const isSwitch = entity.component === 'switch';
  const on = entity.state === true;
  const status = !entity.device.online
    ? [h('span', { class: 'dot bad' }), 'Offline']
    : state.pending.has(entity.entityId)
      ? [h('span', { class: 'dot ok' }), 'Waiting for device…']
      : [h('span', { class: 'dot ok' }), entity.state === null ? 'No report yet' : isSwitch ? (on ? 'On' : 'Off') : on ? 'Active' : 'Idle'];
  return h('div', {
    class: `card tile${on ? ' on' : ''}`, tabindex: '0', role: 'link', 'data-entity': entity.entityId,
    onclick: () => (location.hash = `#/device/${encodeURIComponent(entity.entityId)}`),
    onkeydown: (e) => e.key === 'Enter' && (location.hash = `#/device/${encodeURIComponent(entity.entityId)}`),
  },
    h('div', { class: 'tile-head' }, icon(isSwitch ? 'bulb' : 'sensor'), isSwitch ? switchFor(entity) : null),
    h('div', {}, h('p', { class: 'tile-name' }, pretty(entity.name)), h('p', { class: 'row-sub' }, isSwitch ? 'Switch' : 'Sensor')),
    h('div', { class: 'tile-meta' }, ...status),
  );
}

function viewHome() {
  const entities = allEntities();
  const switches = entities.filter((e) => e.component === 'switch');
  const online = state.devices.filter((d) => d.online).length;
  const onCount = switches.filter((e) => e.state === true).length;
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const h0 = state.health;

  return h('div', {},
    h('p', { class: 'eyebrow' }, greet),
    h('h1', { class: 'title' }, 'Your home, under control'),
    h('div', { class: 'card hero' },
      h('div', { class: 'hero-row' },
        h('div', {}, h('div', { class: 'stat' }, `${onCount}/${switches.length}`), h('div', { class: 'label' }, 'Switches on')),
        h('div', {}, h('div', { class: 'stat' }, `${online}/${state.devices.length}`), h('div', { class: 'label' }, 'Devices online')),
      ),
      h('div', { class: 'chips' },
        h('span', { class: 'chip' }, 'Works without internet'),
        h0 && !h0.timeSynced ? h('span', { class: 'chip warn' }, 'Hub clock not synced: schedules may run at the wrong time') : null,
        h0 && h0.mqtt !== 'up' ? h('span', { class: 'chip warn' }, 'Device network reconnecting') : null,
      ),
    ),
    installCard(),
    entities.length
      ? state.devices.filter((d) => d.entities.length).map((d) => [
          h('div', { class: 'section-title' },
            h('h2', {}, roomName(d)),
            h('span', {}, d.online ? `${d.entities.length} ${d.entities.length === 1 ? 'device' : 'devices'}` : 'Offline')),
          h('div', { class: 'grid' }, d.entities.map((e) => deviceTile({ ...e, device: d }))),
        ])
      : [h('div', { class: 'section-title' }, h('h2', {}, 'Devices')),
         h('div', { class: 'card empty' }, h('div', { html: ICONS.plus }), h('p', {}, 'No devices yet.'), h('a', { href: '#/hub' }, 'How to add a device'))],
  );
}

function viewDevice(entityId) {
  const entity = findEntity(entityId);
  if (!entity) return h('div', {}, backLink(), h('div', { class: 'card empty' }, 'This device is not on the hub.'));
  const isSwitch = entity.component === 'switch';
  const on = entity.state === true;
  const pending = state.pending.has(entity.entityId);
  const label = entity.state === null ? '—' : isSwitch ? (on ? 'On' : 'Off') : on ? 'Active' : 'Idle';

  const schedulesCard = h('div', { class: 'card' }, h('div', { class: 'section-title', style: 'margin-top:0' }, h('h2', {}, 'Schedule'), h('span', {}, 'Runs on the hub')));
  if (isSwitch) loadSchedules(schedulesCard, entity.entityId);

  return h('div', {},
    backLink(),
    h('h1', { class: 'title' }, pretty(entity.name)),
    h('div', { class: 'split' },
      h('div', { class: 'card', 'data-entity': entity.entityId },
        h('div', { class: `dial${on ? ' on' : ''}` },
          h('div', {}, h('div', { class: 'dial-state' }, pending ? '…' : label),
            h('div', { class: 'dial-sub' }, entity.device.online ? `Reported ${since(entity.updatedAt)}` : 'Device offline')),
        ),
        isSwitch
          ? h('div', { class: 'big-toggle' },
              h('button', {
                class: `btn${on ? ' secondary' : ''}`, style: 'min-width:180px',
                disabled: pending || !entity.device.online ? true : null,
                onclick: () => sendCommand(entity.entityId, !on),
              }, !entity.device.online ? 'Device offline' : pending ? 'Waiting for device…' : on ? 'Turn off' : 'Turn on'))
          : null,
        h('p', { class: 'small muted', style: 'text-align:center' }, `${roomName(entity.device)} · ${entity.device.online ? 'Online' : 'Offline'}`),
        isOwner() ? renameForm(entity) : null,
      ),
      isSwitch ? schedulesCard : null,
    ),
  );
}

function renameForm(entity) {
  const name = h('input', { value: pretty(entity.name), maxlength: '64', required: true, 'aria-label': 'Device name' });
  const room = h('input', { value: roomName(entity.device), maxlength: '64', required: true, 'aria-label': 'Room' });
  const form = h('form', { class: 'form', hidden: true, onsubmit: async (e) => {
    e.preventDefault();
    try {
      await api(`/entities/${encodeURIComponent(entity.entityId)}`, { method: 'PATCH', body: { name: name.value } });
      await api(`/devices/${encodeURIComponent(entity.deviceId)}`, { method: 'PATCH', body: { name: room.value } });
      toast('Saved');
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
  } },
    h('div', { class: 'form-row' }, h('label', { class: 'field' }, 'Name', name), h('label', { class: 'field' }, 'Room', room)),
    h('button', { class: 'btn sm', type: 'submit' }, 'Save'),
  );
  const toggle = h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { form.hidden = !form.hidden; toggle.hidden = true; name.focus(); } }, 'Rename');
  return h('div', { style: 'display:grid;justify-items:center;gap:10px;margin-top:6px' }, toggle, form);
}

const backLink = () => h('a', { class: 'back', href: '#/', html: `${ICONS.chevron}<span>Home</span>` });
const isOwner = () => state.role === 'owner';

async function loadSchedules(container, entityId) {
  const { data } = await api('/schedules');
  const list = data.filter((s) => !entityId || s.entityId === entityId);
  container.append(
    list.length
      ? h('div', { class: 'list' }, list.map((s) => scheduleRow(s)))
      : h('p', { class: 'muted small' }, 'No schedules yet.'),
    isOwner() ? scheduleForm(entityId) : h('p', { class: 'small muted' }, 'Only an owner can change schedules.'),
  );
}

function scheduleRow(s) {
  return h('div', { class: 'row' },
    icon('clock', 'avatar'),
    h('div', { class: 'row-main' },
      h('p', { class: 'row-title' }, s.name),
      h('p', { class: 'row-sub' }, `${cronLabel(s.cron)} · turn ${s.value ? 'on' : 'off'} · ${pretty(findEntity(s.entityId)?.name ?? s.entityId)}`)),
    h('span', { class: `badge${s.enabled ? '' : ' grey'}` }, s.enabled ? 'On' : 'Paused'),
    isOwner() ? h('button', { class: 'icon-btn', 'aria-label': `Delete ${s.name}`, html: ICONS.trash, onclick: async () => {
      await api(`/schedules/${s.scheduleId}`, { method: 'DELETE' });
      toast('Schedule deleted');
      render();
    } }) : null,
  );
}

function cronLabel(cron) {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(cron);
  return m ? `Every day at ${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}` : cron;
}

function switchOptions(selected) {
  return allEntities().filter((e) => e.component === 'switch')
    .map((e) => h('option', { value: e.entityId, selected: e.entityId === selected ? true : null }, `${roomName(e.device)} · ${pretty(e.name)}`));
}

function scheduleForm(entityId) {
  const name = h('input', { placeholder: 'Evening lights', required: true, maxlength: '64' });
  const time = h('input', { type: 'time', value: '19:00', required: true });
  const value = h('select', {}, h('option', { value: 'true' }, 'Turn on'), h('option', { value: 'false' }, 'Turn off'));
  const target = h('select', {}, switchOptions(entityId));
  return h('form', { class: 'form', style: 'margin-top:14px', onsubmit: async (e) => {
    e.preventDefault();
    const [hh, mm] = time.value.split(':');
    try {
      await api('/schedules', { method: 'POST', body: { name: name.value, cron: `${Number(mm)} ${Number(hh)} * * *`, entityId: target.value, value: value.value === 'true' } });
      toast('Schedule saved on the hub');
      render();
    } catch (err) { toast(err.message, 'error'); }
  } },
    h('label', { class: 'field' }, 'Name', name),
    h('div', { class: 'form-row' }, h('label', { class: 'field' }, 'Time', time), h('label', { class: 'field' }, 'Action', value)),
    entityId ? null : h('label', { class: 'field' }, 'Device', target),
    h('button', { class: 'btn', type: 'submit', html: `${ICONS.plus.replace('<svg', '<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"')}<span>Add schedule</span>` }),
  );
}

function viewSchedules() {
  const card = h('div', { class: 'card' });
  loadSchedules(card).catch((err) => toast(err.message, 'error'));
  return h('div', {},
    h('p', { class: 'eyebrow' }, 'Runs on your hub, even offline'),
    h('h1', { class: 'title' }, 'Schedules'),
    card,
    h('p', { class: 'small muted' }, 'Missed times are not replayed after a power cut, so nothing switches unexpectedly late.'),
  );
}

function viewAutomations() {
  const card = h('div', { class: 'card' });
  api('/automations').then(({ data }) => {
    card.append(
      data.length ? h('div', { class: 'list' }, data.map((a) => h('div', { class: 'row' },
        icon('bolt', 'avatar'),
        h('div', { class: 'row-main' },
          h('p', { class: 'row-title' }, a.name),
          h('p', { class: 'row-sub' },
            `When ${pretty(findEntity(a.trigger.entityId)?.name ?? a.trigger.entityId)} turns ${a.trigger.to ? 'on' : 'off'} → turn ${pretty(findEntity(a.action.entityId)?.name ?? a.action.entityId)} ${a.action.value ? 'on' : 'off'}` +
            (a.action.revertAfterSeconds ? ` for ${a.action.revertAfterSeconds}s` : ''))),
        h('span', { class: `badge${a.enabled ? '' : ' grey'}` }, a.enabled ? 'On' : 'Paused'),
        isOwner() ? h('button', { class: 'icon-btn', 'aria-label': `Delete ${a.name}`, html: ICONS.trash, onclick: async () => {
          await api(`/automations/${a.automationId}`, { method: 'DELETE' });
          toast('Automation deleted');
          render();
        } }) : null,
      ))) : h('p', { class: 'muted small' }, 'No automations yet.'),
      isOwner() ? automationForm() : h('p', { class: 'small muted' }, 'Only an owner can change automations.'),
    );
  }).catch((err) => toast(err.message, 'error'));
  return h('div', {},
    h('p', { class: 'eyebrow' }, 'Smart rules on your hub'),
    h('h1', { class: 'title' }, 'Automations'),
    card,
  );
}

function automationForm() {
  const entities = allEntities();
  const name = h('input', { placeholder: 'Button turns on hall light', required: true, maxlength: '64' });
  const trigger = h('select', {}, entities.map((e) => h('option', { value: e.entityId }, `${roomName(e.device)} · ${pretty(e.name)}`)));
  const to = h('select', {}, h('option', { value: 'true' }, 'turns on / is pressed'), h('option', { value: 'false' }, 'turns off / is released'));
  const target = h('select', {}, switchOptions());
  const value = h('select', {}, h('option', { value: 'true' }, 'Turn on'), h('option', { value: 'false' }, 'Turn off'));
  const revert = h('input', { type: 'number', min: '1', max: '86400', placeholder: 'Optional, e.g. 60' });
  return h('form', { class: 'form', style: 'margin-top:14px', onsubmit: async (e) => {
    e.preventDefault();
    const action = { entityId: target.value, value: value.value === 'true', ...(revert.value ? { revertAfterSeconds: Number(revert.value) } : {}) };
    try {
      await api('/automations', { method: 'POST', body: { name: name.value, trigger: { entityId: trigger.value, to: to.value === 'true' }, action } });
      toast('Automation saved on the hub');
      render();
    } catch (err) { toast(err.message, 'error'); }
  } },
    h('label', { class: 'field' }, 'Name', name),
    h('div', { class: 'form-row' }, h('label', { class: 'field' }, 'When', trigger), h('label', { class: 'field' }, ' ', to)),
    h('div', { class: 'form-row' }, h('label', { class: 'field' }, 'Then', target), h('label', { class: 'field' }, ' ', value)),
    h('label', { class: 'field' }, 'Switch back after (seconds)', revert),
    h('button', { class: 'btn', type: 'submit' }, 'Add automation'),
  );
}

function viewAccess() {
  if (!isOwner()) {
    return h('div', {}, h('h1', { class: 'title' }, 'User access'),
      h('div', { class: 'card empty' }, h('p', {}, 'Only the home owner can invite or remove people.')));
  }
  const listCard = h('div', { class: 'card' });
  const inviteArea = h('div', {});
  const loadClients = async () => {
    const { data } = await api('/clients');
    listCard.replaceChildren(h('div', { class: 'list' }, data.map((c) => h('div', { class: 'row' },
      h('span', { class: 'avatar' }, c.name.trim().charAt(0).toUpperCase() || '?'),
      h('div', { class: 'row-main' }, h('p', { class: 'row-title' }, c.name), h('p', { class: 'row-sub' }, `Paired ${new Date(c.createdAt).toLocaleDateString()}`)),
      c.revokedAt ? h('span', { class: 'badge bad' }, 'Removed') : h('span', { class: `badge${c.role === 'owner' ? '' : ' grey'}` }, c.role),
      c.clientId === state.clientId ? h('span', { class: 'small muted' }, 'You') : c.revokedAt ? null : h('button', { class: 'btn danger sm', onclick: async () => {
        if (!confirm(`Remove ${c.name}? Their app stops working on this hub immediately.`)) return;
        try {
          await api(`/clients/${c.clientId}`, { method: 'DELETE' });
          toast(`${c.name} removed`);
          loadClients();
        } catch (err) { toast(err.status === 409 ? 'You can’t remove the last owner.' : err.message, 'error'); }
      } }, 'Remove'),
    ))));
  };
  loadClients().catch((err) => toast(err.message, 'error'));

  const invite = h('button', { class: 'btn', onclick: async () => {
    const { data } = await api('/pairing-codes', { method: 'POST' });
    const pretty = `${data.code.slice(0, 5)}-${data.code.slice(5)}`;
    const left = h('p', { class: 'small muted' });
    const tick = () => {
      const s = Math.max(0, Math.round((data.expiresAt - Date.now()) / 1000));
      left.textContent = s ? `Single use · expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'Expired. Create a new code.';
      if (s && document.body.contains(left)) setTimeout(tick, 1000);
    };
    tick();
    inviteArea.replaceChildren(h('div', { class: 'code-box' }, h('p', { class: 'muted small' }, 'Share this code with the person you are inviting'), h('div', { class: 'code' }, pretty), left));
  } }, 'Invite a member');

  return h('div', {},
    h('p', { class: 'eyebrow' }, 'Smarter living, managed together'),
    h('h1', { class: 'title' }, 'User access'),
    h('div', { class: 'split' },
      listCard,
      h('div', { class: 'card' },
        h('h2', { style: 'margin:0 0 6px;font-size:1.1875rem' }, 'Share control with family'),
        h('p', { class: 'muted small' }, 'Members can control devices. Only owners can change schedules, automations and access.'),
        invite, h('div', { style: 'margin-top:14px' }, inviteArea)),
    ),
  );
}

function viewHub() {
  const hh = state.health;
  const rows = hh ? [
    ['Hub', `${state.hub?.name ?? ''} · ${hh.hubId}`],
    ['Software', hh.version],
    ['Status', hh.status === 'ok' ? 'All systems normal' : 'Degraded'],
    ['Database', hh.db === 'up' ? 'Healthy' : 'Down'],
    ['Device network (MQTT)', hh.mqtt === 'up' ? 'Connected' : 'Reconnecting'],
    ['Clock', hh.timeSynced ? 'Synced' : 'Not synced (no internet since boot?)'],
    ['Uptime', `${Math.floor(hh.uptime / 3600)}h ${Math.floor((hh.uptime % 3600) / 60)}m`],
    ['Your role', state.role ?? ''],
  ] : [];
  return h('div', {},
    h('p', { class: 'eyebrow' }, 'Your local home server'),
    h('h1', { class: 'title' }, 'Hub'),
    h('div', { class: 'split' },
      h('div', { class: 'card' }, h('div', { class: 'list' }, rows.map(([k, v]) =>
        h('div', { class: 'row' }, h('div', { class: 'row-main' }, h('p', { class: 'row-sub', style: 'margin:0' }, k), h('p', { class: 'row-title' }, v)))))),
      h('div', { class: 'card' },
        h('h2', { style: 'margin:0 0 8px;font-size:1.1875rem' }, 'Add a device'),
        h('p', { class: 'muted small' }, 'New VOLTEX switches are added by your installer. Each device gets its own secure credential on this hub, then appears here automatically once it reports in.'),
        h('ol', { class: 'small', style: 'padding-left:18px;color:var(--navy-2)' },
          h('li', {}, 'Installer runs add-device on the hub'),
          h('li', {}, 'Installer flashes the switch with its credential'),
          h('li', {}, 'The switch connects and shows up on Home')),
        installCard({ compact: true }),
        h('button', { class: 'btn ghost block', style: 'margin-top:8px', onclick: () => { if (confirm('Forget this hub on this browser?')) signOut(); } }, 'Sign out of this browser'),
      ),
    ),
  );
}

// ---------- router ----------
let currentRoute = '';
// Live updates re-render only screens that show live state, so forms are never wiped mid-typing.
function renderLive() {
  const tab = location.hash.split('/')[1] || 'home';
  if (!state.token || tab === 'home' || tab === 'device' || tab === 'hub') render();
}
function render() {
  const view = document.getElementById('view');
  const topbar = document.getElementById('topbar');
  const tabbar = document.getElementById('tabbar');
  const authed = Boolean(state.token);
  topbar.hidden = !authed;
  tabbar.hidden = !authed;

  const route = authed ? location.hash.slice(1) || '/' : '/pair';
  const [, section, arg] = route.split('/');
  const tab = section || 'home';
  for (const a of tabbar.querySelectorAll('a')) a.toggleAttribute('aria-current', a.dataset.tab === (tab === 'device' ? 'home' : tab));
  for (const a of tabbar.querySelectorAll('a[aria-current]')) a.setAttribute('aria-current', 'page');

  const scroll = window.scrollY;
  const next =
    !authed ? viewPair()
    : tab === 'device' ? viewDevice(decodeURIComponent(arg ?? ''))
    : tab === 'schedules' ? viewSchedules()
    : tab === 'automations' ? viewAutomations()
    : tab === 'access' ? viewAccess()
    : tab === 'hub' ? viewHub()
    : viewHome();
  view.replaceChildren(next);
  if (route !== currentRoute) {
    view.classList.remove('enter');
    void view.offsetWidth;
    view.classList.add('enter');
    window.scrollTo(0, 0);
    currentRoute = route;
  } else {
    window.scrollTo(0, scroll);
  }
}

async function start() {
  render();
  if (!state.token) return;
  setConn('connecting');
  await refresh();
  connectWs();
}

// ---------- PWA: offline app shell + install ----------
const pwa = {
  prompt: null, // Chrome/Edge/Android install prompt, captured for our own button
  standalone: matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
  ios: /iphone|ipad|ipod/i.test(navigator.userAgent),
  dismissed: localStorage.getItem('voltax.installDismissed') === '1',
};

function installCard({ compact = false } = {}) {
  if (pwa.standalone || (!compact && pwa.dismissed)) return null;
  if (!pwa.prompt && !pwa.ios) return null;
  const body = pwa.prompt
    ? h('button', { class: 'btn sm', onclick: async () => {
        pwa.prompt.prompt();
        const { outcome } = await pwa.prompt.userChoice;
        pwa.prompt = null;
        if (outcome === 'accepted') toast('VOLTEX added to your home screen');
        render();
      } }, 'Install app')
    : h('p', { class: 'small muted', style: 'margin:0' }, 'Tap Share, then “Add to Home Screen”.');
  return h('div', { class: 'card install' },
    h('img', { src: 'icon-192.png', alt: '', width: '44', height: '44' }),
    h('div', { class: 'row-main' }, h('p', { class: 'row-title' }, 'Get the VOLTEX app'), h('p', { class: 'row-sub' }, 'Opens full-screen, right from your home screen.')),
    body,
    compact ? null : h('button', { class: 'icon-btn', 'aria-label': 'Not now', html: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>', onclick: () => {
      localStorage.setItem('voltax.installDismissed', '1');
      pwa.dismissed = true;
      render();
    } }),
  );
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  pwa.prompt = e;
  renderLive();
});
window.addEventListener('appinstalled', () => {
  pwa.prompt = null;
  pwa.standalone = true;
  renderLive();
});

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').then((reg) => {
    // A new version was downloaded: offer a one-tap refresh instead of a silent swap.
    reg.addEventListener('updatefound', () => {
      const next = reg.installing;
      next?.addEventListener('statechange', () => {
        if (next.state === 'installed' && navigator.serviceWorker.controller) {
          toast('A new version of VOLTEX is ready. Refreshing…');
          next.postMessage('skip-waiting');
        }
      });
    });
  }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!reloaded) { reloaded = true; location.reload(); }
  });
}

window.addEventListener('hashchange', render);
api('/hub/identity').then(({ data }) => { state.hub = data; render(); }).catch(() => {});
start();
