'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { navFor, ROLE_LABEL } from '@/lib/nav';
import { Icon } from './Icon';
import { OPEN_PAGES, useSession } from './Session';
import { useToast } from './Toast';

// Detail pages live outside their list's folder (static export: query-string ids).
const SECTION_OF: Record<string, string> = {
  '/home/': '/homes/',
  '/rollout/': '/fleet/',
};

/** Sidebar on wide screens, a top bar with a menu on phones, around every signed-in page. */
export function Shell({ children }: { children: ReactNode }) {
  const { me, ready, offline, reload, signOut } = useSession();
  const path = usePathname();
  const [menu, setMenu] = useState(false);
  useServiceWorker();
  useEffect(() => setMenu(false), [path]);

  if (OPEN_PAGES.includes(path)) return <>{children}</>;
  // Live data is never cached (stale grants or rollouts must not be acted on), so offline there is
  // nothing to show beyond saying so.
  if (offline && !me)
    return (
      <div className="auth">
        <section className="card auth-card" role="alert">
          <h1 className="title">Can&apos;t reach VOLTEX</h1>
          <p className="sub">The portal needs a connection to the VOLTEX cloud. Nothing is shown from a cache, so you never act on out-of-date access or fleet data.</p>
          <button className="btn block" onClick={() => void reload()}>
            Try again
          </button>
        </section>
      </div>
    );
  if (!ready || !me?.mfa) return <div className="boot" aria-busy="true" aria-label="Loading" />;

  const section = SECTION_OF[path] ?? path;
  const current = (href: string) => (href === '/' ? section === '/' : section.startsWith(href));

  return (
    <div className="frame">
      <aside className="side" data-open={menu}>
        <div className="side-head">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="logo for-light" src="/brand/logo-wordmark.svg" alt="VOLTEX" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="logo for-dark" src="/brand/logo-wordmark-dark.svg" alt="VOLTEX" />
          <span className="side-tag">Admin</span>
          <button className="icon-btn menu-btn" aria-label="Menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
            <Icon name="menu" />
          </button>
        </div>
        <nav aria-label="Main">
          {navFor(me.staff.role).map((n) => (
            <Link key={n.href} href={n.href} aria-current={current(n.href) ? 'page' : undefined}>
              <Icon name={n.icon} />
              <span>{n.label}</span>
            </Link>
          ))}
        </nav>
        <div className="side-me">
          <span className="avatar">{me.staff.displayName.charAt(0).toUpperCase()}</span>
          <div className="row-main">
            <p className="row-title">{me.staff.displayName}</p>
            <p className="row-sub">{ROLE_LABEL[me.staff.role]}</p>
          </div>
          <button className="icon-btn" aria-label="Sign out" title="Sign out" onClick={() => void signOut()}>
            <Icon name="out" />
          </button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}

/** Production builds only (it would cache stale files during `next dev`). */
function useServiceWorker() {
  const toast = useToast();
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator) || !isSecureContext) return;
    let reloaded = false;
    const onChange = () => {
      if (!reloaded) {
        reloaded = true;
        location.reload();
      }
    };
    navigator.serviceWorker.addEventListener('controllerchange', onChange);
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) =>
        reg.addEventListener('updatefound', () => {
          const next = reg.installing;
          next?.addEventListener('statechange', () => {
            if (next.state === 'installed' && navigator.serviceWorker.controller) {
              toast('A new version of the portal is ready. Refreshing…');
              next.postMessage('skip-waiting');
            }
          });
        }),
      )
      .catch(() => {});
    return () => navigator.serviceWorker.removeEventListener('controllerchange', onChange);
  }, [toast]);
}
