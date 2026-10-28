// Pairing session: the hub-issued token is this browser's only credential.
import { toast } from '../core/dom.js';
import { state, STORAGE } from '../core/state.js';
import { render } from '../router.js';
import { connectWs, refresh, setConn } from './live.js';

export async function start() {
  render();
  if (!state.token) return;
  setConn('connecting');
  await refresh();
  connectWs();
}

export function signIn({ token, role, clientId }) {
  Object.assign(state, { token, role, clientId });
  localStorage.setItem(STORAGE.token, token);
  localStorage.setItem(STORAGE.role, role);
  localStorage.setItem(STORAGE.clientId, clientId);
  return start();
}

export function signOut(message) {
  localStorage.removeItem(STORAGE.token);
  localStorage.removeItem(STORAGE.role);
  localStorage.removeItem(STORAGE.clientId);
  state.token = null;
  state.role = null;
  const ws = state.ws;
  state.ws = null;
  ws?.close();
  if (message) toast(message, 'error');
  render();
}
