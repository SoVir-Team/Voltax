'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { PairScreen } from '@/features/pairing/PairScreen';
import { SupportBanner } from '@/features/support/SupportBanner';
import { useHub, type Connection } from '@/providers/HubProvider';
import { Icon, type IconName } from './Icon';

const CONN_LABEL: Record<Connection, string> = { live: 'Local · Live', connecting: 'Connecting', offline: 'Hub unreachable' };

const TABS: { href: string; tab: string; label: string; icon: IconName }[] = [
  { href: '/', tab: 'home', label: 'Home', icon: 'home' },
  { href: '/schedules/', tab: 'schedules', label: 'Schedules', icon: 'clock' },
  { href: '/automations/', tab: 'automations', label: 'Automations', icon: 'bolt' },
  { href: '/access/', tab: 'access', label: 'Access', icon: 'people' },
  { href: '/hub/', tab: 'hub', label: 'Hub', icon: 'hub' },
];

/** Top bar + current screen + floating tab bar. Shows pairing until this browser has a hub token. */
export function AppShell({ children }: { children: ReactNode }) {
  const { ready, session, conn } = useHub();
  const pathname = usePathname();

  if (!ready) return <div className="app" />; // static HTML: the session lives in this browser only
  if (!session) return <PairScreen />;

  const section = pathname.split('/')[1] || 'home';
  const current = section === 'device' ? 'home' : section;

  return (
    <div className="app">
      <header className="topbar">
        {/* eslint-disable-next-line @next/next/no-img-element -- static export, no image optimiser */}
        <img className="topbar-logo for-light" src="/brand/logo-wordmark.svg" alt="VOLTEX" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="topbar-logo for-dark" src="/brand/logo-wordmark-dark.svg" alt="VOLTEX" />
        <span className="conn" data-state={conn} role="status" aria-live="polite">
          <i />
          <span>{CONN_LABEL[conn]}</span>
        </span>
      </header>
      <SupportBanner />

      {/* key: replay the entrance animation on every route change */}
      <main key={pathname} className="view enter" tabIndex={-1}>
        {children}
      </main>

      <nav className="tabbar" aria-label="Main">
        {TABS.map((t) => (
          <Link key={t.tab} href={t.href} aria-current={t.tab === current ? 'page' : undefined}>
            <Icon name={t.icon} />
            <span>{t.label}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
