'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { timeLeft } from '@/lib/format';
import { useHub } from '@/providers/HubProvider';
import { useGrants } from './useGrants';

/** On every screen while support has access (everyone) or is waiting for the owner's OK (owners). */
export function SupportBanner() {
  const { isOwner } = useHub();
  const { pending, active } = useGrants();
  const onAccess = usePathname().startsWith('/access');
  const live = active[0];

  if (live) {
    return (
      <div className="banner live" role="status">
        <span className="banner-dot" aria-hidden="true" />
        <span className="banner-text">
          <strong>{live.staff.displayName}</strong> from VOLTEX support has access · {timeLeft(live.endsAt)} left
        </span>
        {!onAccess && (
          <Link className="banner-link" href="/access/#support-title">
            {isOwner ? 'Manage' : 'Details'}
          </Link>
        )}
      </div>
    );
  }
  if (isOwner && pending.length > 0) {
    return (
      <div className="banner ask" role="status">
        <span className="banner-text">
          VOLTEX support is asking for access{pending.length > 1 ? ` (${pending.length} requests)` : ''}
        </span>
        {!onAccess && (
          <Link className="banner-link" href="/access/#support-title">
            Review
          </Link>
        )}
      </div>
    );
  }
  return null;
}
