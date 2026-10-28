// VOLTEX hub UI entry point. Talks only to the local hub API (/api/v1) and its WebSocket.
// It always renders the state the DEVICE REPORTED, never the state it asked for.
import { api } from './core/api.js';
import { state } from './core/state.js';
import { initPwa } from './pwa.js';
import { render } from './router.js';
import { start } from './services/session.js';

initPwa();
window.addEventListener('hashchange', render);
api('/hub/identity').then(({ data }) => { state.hub = data; render(); }).catch(() => {});
start();
