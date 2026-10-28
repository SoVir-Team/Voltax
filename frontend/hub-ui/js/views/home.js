// Home: summary card and every device, grouped by room.
import { switchFor } from '../components/controls.js';
import { h, icon, ICONS } from '../core/dom.js';
import { pretty, roomName } from '../core/format.js';
import { allEntities, state } from '../core/state.js';
import { installCard } from '../pwa.js';

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

export function viewHome() {
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
