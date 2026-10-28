// One device: big state dial, on/off action, rename (owner) and its schedules.
import { backLink } from '../components/controls.js';
import { api } from '../core/api.js';
import { h, toast } from '../core/dom.js';
import { pretty, roomName, since } from '../core/format.js';
import { findEntity, isOwner, state } from '../core/state.js';
import { refresh, sendCommand } from '../services/live.js';
import { loadSchedules } from './schedules.js';

export function viewDevice(entityId) {
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
