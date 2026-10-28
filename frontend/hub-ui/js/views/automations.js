// "When X happens, do Y" rules, evaluated on the hub.
import { switchOptions } from '../components/controls.js';
import { api } from '../core/api.js';
import { h, icon, ICONS, toast } from '../core/dom.js';
import { pretty, roomName } from '../core/format.js';
import { allEntities, findEntity, isOwner } from '../core/state.js';
import { render } from '../router.js';

export function viewAutomations() {
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
