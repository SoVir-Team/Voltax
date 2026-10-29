import type { RolloutView } from '@voltax/contracts';

export const dateTime = (ms: number | null | undefined): string =>
  ms
    ? new Date(ms).toLocaleString([], {
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '—';

export const ago = (ms: number | null | undefined, now = Date.now()): string => {
  if (!ms) return 'never';
  const s = Math.round((now - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};

export const GRANT_ACTION_LABEL: Record<string, string> = {
  'device.command': 'Control devices',
  'diagnostics.read': 'Diagnostics',
  'activity.read': 'Recent activity',
  'hub.restart': 'Restart hub',
};

/** Badge tone for a status word. */
export function tone(status: string): 'ok' | 'warn' | 'bad' | 'grey' {
  if (['active', 'running', 'done', 'completed', 'delivered', 'confirmed', 'ok', 'allowed', 'eligible'].includes(status)) return 'ok';
  if (['pending', 'offered', 'awaiting_approval', 'requested', 'applying', 'halted', 'sent'].includes(status)) return 'warn';
  if (['failed', 'rolled_back', 'rejected', 'revoked', 'denied', 'error', 'expired', 'cancelled'].includes(status)) return 'bad';
  return 'grey';
}

/** One line on where a rollout stands, from its per-state hub counts. */
export function progress(r: Pick<RolloutView, 'counts'>): string {
  const c = r.counts;
  const failed = (c.failed ?? 0) + (c.rolled_back ?? 0);
  const waiting = (c.offered ?? 0) + (c.requested ?? 0) + (c.applying ?? 0);
  return `${c.done ?? 0} updated · ${waiting} in progress · ${failed} failed · ${c.declined ?? 0} declined`;
}
