// Hub health, how devices are added, install and sign-out.
import { h } from '../core/dom.js';
import { state } from '../core/state.js';
import { installCard } from '../pwa.js';
import { signOut } from '../services/session.js';

export function viewHub() {
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
