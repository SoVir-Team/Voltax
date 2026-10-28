// PWA: "install app" card and the service worker (offline app shell, never cached API).
import { h, ICONS, toast } from './core/dom.js';
import { STORAGE } from './core/state.js';
import { render, renderLive } from './router.js';

const pwa = {
  prompt: null, // Chrome/Edge/Android install prompt, captured for our own button
  standalone: matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
  ios: /iphone|ipad|ipod/i.test(navigator.userAgent),
  dismissed: localStorage.getItem(STORAGE.installDismissed) === '1',
};

export function installCard({ compact = false } = {}) {
  if (pwa.standalone || (!compact && pwa.dismissed)) return null;
  if (!pwa.prompt && !pwa.ios) return null;
  const body = pwa.prompt
    ? h('button', { class: 'btn sm', onclick: async () => {
        pwa.prompt.prompt();
        const { outcome } = await pwa.prompt.userChoice;
        pwa.prompt = null;
        if (outcome === 'accepted') toast('VOLTEX added to your home screen');
        render();
      } }, 'Install app')
    : h('p', { class: 'small muted', style: 'margin:0' }, 'Tap Share, then “Add to Home Screen”.');
  return h('div', { class: 'card install' },
    h('img', { src: 'assets/icons/icon-192.png', alt: '', width: '44', height: '44' }),
    h('div', { class: 'row-main' }, h('p', { class: 'row-title' }, 'Get the VOLTEX app'), h('p', { class: 'row-sub' }, 'Opens full-screen, right from your home screen.')),
    body,
    compact ? null : h('button', { class: 'icon-btn', 'aria-label': 'Not now', html: ICONS.close, onclick: () => {
      localStorage.setItem(STORAGE.installDismissed, '1');
      pwa.dismissed = true;
      render();
    } }),
  );
}

export function initPwa() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    pwa.prompt = e;
    renderLive();
  });
  window.addEventListener('appinstalled', () => {
    pwa.prompt = null;
    pwa.standalone = true;
    renderLive();
  });

  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    // A new version was downloaded: offer a one-tap refresh instead of a silent swap.
    reg.addEventListener('updatefound', () => {
      const next = reg.installing;
      next?.addEventListener('statechange', () => {
        if (next.state === 'installed' && navigator.serviceWorker.controller) {
          toast('A new version of VOLTEX is ready. Refreshing…');
          next.postMessage('skip-waiting');
        }
      });
    });
  }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!reloaded) { reloaded = true; location.reload(); }
  });
}
