// Daily schedules. They run on the hub itself, so they keep working without internet.
import { switchOptions, timePicker12 } from '../components/controls.js';
import { api } from '../core/api.js';
import { h, icon, ICONS, toast } from '../core/dom.js';
import { cronLabel, pretty } from '../core/format.js';
import { findEntity, isOwner } from '../core/state.js';
import { render } from '../router.js';

export async function loadSchedules(container, entityId) {
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

function scheduleForm(entityId) {
  const name = h('input', { placeholder: 'Evening lights', required: true, maxlength: '64' });
  const time = timePicker12();
  const value = h('select', {}, h('option', { value: 'true' }, 'Turn on'), h('option', { value: 'false' }, 'Turn off'));
  const target = h('select', {}, switchOptions(entityId));
  return h('form', { class: 'form', style: 'margin-top:14px', onsubmit: async (e) => {
    e.preventDefault();
    const { hour, minute } = time.value();
    try {
      await api('/schedules', { method: 'POST', body: { name: name.value, cron: `${minute} ${hour} * * *`, entityId: target.value, value: value.value === 'true' } });
      toast('Schedule saved on the hub');
      render();
    } catch (err) { toast(err.message, 'error'); }
  } },
    h('label', { class: 'field' }, 'Name', name),
    h('div', { class: 'field' }, h('span', {}, 'Time'), time.el),
    h('label', { class: 'field' }, 'Action', value),
    entityId ? null : h('label', { class: 'field' }, 'Device', target),
    h('button', { class: 'btn', type: 'submit', html: `${ICONS.plus.replace('<svg', '<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"')}<span>Add schedule</span>` }),
  );
}

export function viewSchedules() {
  const card = h('div', { class: 'card' });
  loadSchedules(card).catch((err) => toast(err.message, 'error'));
  return h('div', {},
    h('p', { class: 'eyebrow' }, 'Runs on your hub, even offline'),
    h('h1', { class: 'title' }, 'Schedules'),
    card,
    h('p', { class: 'small muted' }, 'Missed times are not replayed after a power cut, so nothing switches unexpectedly late.'),
  );
}
