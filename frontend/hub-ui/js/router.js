// Hash router: #/, #/device/<id>, #/schedules, #/automations, #/access, #/hub.
import { state } from './core/state.js';
import { viewAccess } from './views/access.js';
import { viewAutomations } from './views/automations.js';
import { viewDevice } from './views/device.js';
import { viewHome } from './views/home.js';
import { viewHub } from './views/hub.js';
import { viewPair } from './views/pair.js';
import { viewSchedules } from './views/schedules.js';

let currentRoute = '';

// Live updates re-render only screens that show live state, so forms are never wiped mid-typing.
export function renderLive() {
  const tab = location.hash.split('/')[1] || 'home';
  if (!state.token || tab === 'home' || tab === 'device' || tab === 'hub') render();
}

export function render() {
  const view = document.getElementById('view');
  const topbar = document.getElementById('topbar');
  const tabbar = document.getElementById('tabbar');
  const authed = Boolean(state.token);
  topbar.hidden = !authed;
  tabbar.hidden = !authed;

  const route = authed ? location.hash.slice(1) || '/' : '/pair';
  const [, section, arg] = route.split('/');
  const tab = section || 'home';
  for (const a of tabbar.querySelectorAll('a')) a.toggleAttribute('aria-current', a.dataset.tab === (tab === 'device' ? 'home' : tab));
  for (const a of tabbar.querySelectorAll('a[aria-current]')) a.setAttribute('aria-current', 'page');

  const scroll = window.scrollY;
  const next =
    !authed ? viewPair()
    : tab === 'device' ? viewDevice(decodeURIComponent(arg ?? ''))
    : tab === 'schedules' ? viewSchedules()
    : tab === 'automations' ? viewAutomations()
    : tab === 'access' ? viewAccess()
    : tab === 'hub' ? viewHub()
    : viewHome();
  view.replaceChildren(next);
  if (route !== currentRoute) {
    view.classList.remove('enter');
    void view.offsetWidth;
    view.classList.add('enter');
    window.scrollTo(0, 0);
    currentRoute = route;
  } else {
    window.scrollTo(0, scroll);
  }
}
