'use client';

import { useCallback, useEffect, useState } from 'react';
import type { GrantView } from '@/lib/types';
import { useHub } from '@/providers/HubProvider';

/**
 * Support grants as the hub stores them (the hub is the authority). Refetched on every support
 * event and every 30 s, so an expired session disappears even with no event.
 */
export function useGrants() {
  const { api, onEvent, session } = useHub();
  const [grants, setGrants] = useState<GrantView[]>([]);

  const load = useCallback(() => {
    api<GrantView[]>('/support/grants').then(
      ({ data }) => setGrants(data),
      () => {},
    );
  }, [api]);

  useEffect(() => {
    if (!session) return;
    load();
    const timer = setInterval(load, 30_000);
    const off = onEvent((e) => {
      if (e.type.startsWith('support.')) load();
    });
    return () => {
      clearInterval(timer);
      off();
    };
  }, [session, load, onEvent]);

  const now = Date.now();
  return {
    grants,
    reload: load,
    pending: grants.filter((g) => g.status === 'pending' && g.endsAt > now),
    active: grants.filter((g) => g.status === 'active' && g.endsAt > now),
    past: grants.filter((g) => !(['pending', 'active'] as string[]).includes(g.status) || g.endsAt <= now),
  };
}
