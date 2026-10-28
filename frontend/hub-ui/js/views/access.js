// Owner-only: see paired phones/browsers, invite members, remove access.
import { api } from '../core/api.js';
import { h, toast } from '../core/dom.js';
import { isOwner, state } from '../core/state.js';

export function viewAccess() {
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
    const display = `${data.code.slice(0, 5)}-${data.code.slice(5)}`;
    const left = h('p', { class: 'small muted' });
    const tick = () => {
      const s = Math.max(0, Math.round((data.expiresAt - Date.now()) / 1000));
      left.textContent = s ? `Single use · expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'Expired. Create a new code.';
      if (s && document.body.contains(left)) setTimeout(tick, 1000);
    };
    tick();
    inviteArea.replaceChildren(h('div', { class: 'code-box' }, h('p', { class: 'muted small' }, 'Share this code with the person you are inviting'), h('div', { class: 'code' }, display), left));
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
