// Reusable controls shared by several screens.
import { h, ICONS } from '../core/dom.js';
import { pretty, roomName } from '../core/format.js';
import { allEntities, state } from '../core/state.js';
import { sendCommand } from '../services/live.js';

export function switchFor(entity) {
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

export function switchOptions(selected) {
  return allEntities().filter((e) => e.component === 'switch')
    .map((e) => h('option', { value: e.entityId, selected: e.entityId === selected ? true : null }, `${roomName(e.device)} · ${pretty(e.name)}`));
}

// Native <input type=time> follows the device locale (often 24-hour), so build an explicit 12-hour picker.
export function timePicker12(h24 = 19, min = 0) {
  const opts = (values, label, selected) => values.map((v) => h('option', { value: String(v), selected: v === selected ? true : null }, label(v)));
  const hour = h('select', { 'aria-label': 'Hour' }, opts([12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], String, h24 % 12 || 12));
  const minute = h('select', { 'aria-label': 'Minute' }, opts([...Array(60).keys()], (v) => String(v).padStart(2, '0'), min));
  const ampm = h('select', { 'aria-label': 'AM or PM' }, opts(['AM', 'PM'], String, h24 < 12 ? 'AM' : 'PM'));
  return {
    el: h('div', { class: 'time-picker' }, hour, minute, ampm),
    value: () => ({ hour: (Number(hour.value) % 12) + (ampm.value === 'PM' ? 12 : 0), minute: Number(minute.value) }),
  };
}

export const backLink = () => h('a', { class: 'back', href: '#/', html: `${ICONS.chevron}<span>Home</span>` });
