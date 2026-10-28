// The only way the UI talks to the hub: its local REST API (/api/v1).
import { state } from './state.js';
import { signOut } from '../services/session.js';

export const API = '/api/v1';

export async function api(path, { method = 'GET', body } = {}) {
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

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
