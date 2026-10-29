import type { ReactNode } from 'react';
import type { NavItem } from '@/lib/nav';

type IconName = NavItem['icon'] | 'out' | 'menu' | 'back';

const PATHS: Record<IconName, ReactNode> = {
  overview: <path d="M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-4H4zM14 4v4h6V4z" />,
  homes: <path d="M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
  support: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c.9-3.6 3.6-5.5 7-5.5s6.1 1.9 7 5.5" />
    </>
  ),
  fleet: (
    <>
      <rect x="3.5" y="5" width="17" height="11" rx="2.5" />
      <path d="M8 20h8M12 16v4M8.5 10.5l2.5 2 4.5-4.5" />
    </>
  ),
  releases: <path d="M12 3v12M7 10l5 5 5-5M5 20h14" />,
  audit: <path d="M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6" />,
  staff: (
    <>
      <circle cx="9" cy="8.5" r="3.5" />
      <path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5M16 5.2a3.4 3.4 0 0 1 0 6.6M18.5 14.8c1.6.8 2.6 2.5 3 5.2" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" />
    </>
  ),
  out: <path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  back: <path d="M15 5l-7 7 7 7" />,
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}
