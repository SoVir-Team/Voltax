'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useToast } from './ToastProvider';

// Chrome/Edge/Android only; not in the DOM typings.
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface PwaState {
  canPrompt: boolean;
  ios: boolean;
  standalone: boolean;
  dismissed: boolean;
  install(): Promise<void>;
  dismiss(): void;
}

const DISMISSED_KEY = 'voltax.installDismissed';
const PwaContext = createContext<PwaState | null>(null);

export function PwaProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [env, setEnv] = useState({ ios: false, standalone: false, dismissed: true });

  useEffect(() => {
    setEnv({
      ios: /iphone|ipad|ipod/i.test(navigator.userAgent),
      standalone: matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true,
      dismissed: localStorage.getItem(DISMISSED_KEY) === '1',
    });
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setPrompt(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setPrompt(null);
      setEnv((s) => ({ ...s, standalone: true }));
    };
    addEventListener('beforeinstallprompt', onPrompt);
    addEventListener('appinstalled', onInstalled);
    return () => {
      removeEventListener('beforeinstallprompt', onPrompt);
      removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  // Service worker: production builds only (it would cache stale files during `next dev`).
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator) || !isSecureContext) return;
    let reloaded = false;
    const onControllerChange = () => {
      if (!reloaded) {
        reloaded = true;
        location.reload();
      }
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        // A new version was downloaded: swap to it straight away and say so.
        reg.addEventListener('updatefound', () => {
          const next = reg.installing;
          next?.addEventListener('statechange', () => {
            if (next.state === 'installed' && navigator.serviceWorker.controller) {
              toast('A new version of VOLTEX is ready. Refreshing…');
              next.postMessage('skip-waiting');
            }
          });
        });
      })
      .catch(() => {});
    return () => navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
  }, [toast]);

  const install = useCallback(async () => {
    if (!prompt) return;
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    setPrompt(null);
    if (outcome === 'accepted') toast('VOLTEX added to your home screen');
  }, [prompt, toast]);

  const dismiss = useCallback(() => {
    localStorage.setItem(DISMISSED_KEY, '1');
    setEnv((s) => ({ ...s, dismissed: true }));
  }, []);

  return <PwaContext.Provider value={{ canPrompt: prompt !== null, ...env, install, dismiss }}>{children}</PwaContext.Provider>;
}

export function usePwa(): PwaState {
  const ctx = useContext(PwaContext);
  if (!ctx) throw new Error('usePwa must be used inside <PwaProvider>');
  return ctx;
}
