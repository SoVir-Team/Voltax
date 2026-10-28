// First screen on a new browser: exchange a one-time pairing code for a hub token.
import { api } from '../core/api.js';
import { h, toast } from '../core/dom.js';
import { state } from '../core/state.js';
import { signIn } from '../services/session.js';

export function viewPair() {
  const code = h('input', { class: 'code-input', id: 'code', autocomplete: 'one-time-code', maxlength: '11', placeholder: 'XXXXX-XXXXX', required: true });
  const name = h('input', { id: 'name', maxlength: '64', placeholder: 'e.g. Priya’s iPhone', required: true });
  const submit = h('button', { class: 'btn block', type: 'submit' }, 'Connect to hub');
  const form = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault();
    submit.disabled = true;
    try {
      const { data } = await api('/pair', { method: 'POST', body: { pairingCode: code.value, clientName: name.value } });
      toast('Connected to your VOLTEX hub');
      void signIn(data);
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
      h('img', { src: 'assets/brand/logo.svg', alt: 'VOLTEX' }),
      h('h1', { class: 'title' }, 'Connect to your home'),
      h('p', { class: 'muted' }, `Enter the one-time code from your installer or from the owner’s app. Codes expire after a few minutes and work once.`),
      state.hub ? h('p', { class: 'small muted' }, `Hub ${state.hub.name} · ${state.hub.hubId}`) : null,
      form,
    ),
  );
}
