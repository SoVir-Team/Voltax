'use client';

import type { MeView, PlatformAction } from '@voltax/contracts';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '@/lib/api';
import { can } from '@/lib/nav';

interface SessionValue {
  me: MeView | null;
  ready: boolean;
  /** The cloud could not be reached (no connection). Distinct from signed out. */
  offline: boolean;
  reload(): Promise<void>;
  signOut(): Promise<void>;
  /** For hiding controls only: the cloud checks role, assignment and session on every request. */
  can(action: PlatformAction): boolean;
}

const SessionContext = createContext<SessionValue | null>(null);
export const OPEN_PAGES = ['/login/', '/setup/'];

/** Who is signed in. The session cookie is HttpOnly; this only mirrors /auth/me for the UI. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeView | null>(null);
  const [ready, setReady] = useState(false);
  const [offline, setOffline] = useState(false);
  const router = useRouter();
  const path = usePathname();

  const reload = useCallback(async () => {
    try {
      setMe(await api<MeView>('/auth/me'));
      setOffline(false);
    } catch (err) {
      if (err instanceof ApiError) {
        setOffline(false);
        if (err.status === 401) setMe(null);
      } else setOffline(true); // network failure: we do not know who is signed in, so do not send them to login
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void reload();
    const retry = () => void reload();
    addEventListener('online', retry);
    return () => removeEventListener('online', retry);
  }, [reload]);

  // Only a valid password-authenticated session opens the portal.
  useEffect(() => {
    if (!ready || offline) return;
    if (!me && !OPEN_PAGES.includes(path)) router.replace('/login/');
    else if (me && OPEN_PAGES.includes(path)) router.replace('/');
  }, [ready, offline, me, path, router]);

  const signOut = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    setMe(null);
    router.replace('/login/');
  }, [router]);

  const value: SessionValue = {
    me,
    ready,
    offline,
    reload,
    signOut,
    can: (a) => !!me && can(me.staff.role, a),
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession outside SessionProvider');
  return ctx;
}
