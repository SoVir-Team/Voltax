'use client';

import { useState } from 'react';
import { GRANT_ACTION_LABEL, pretty, timeLeft } from '@/lib/format';
import type { GrantView } from '@/lib/types';
import { useHub } from '@/providers/HubProvider';
import { useToast } from '@/providers/ToastProvider';
import { useGrants } from './useGrants';

const ROLE_LABEL: Record<string, string> = { PLATFORM_SUPPORT: 'VOLTEX support', INSTALLER: 'VOLTEX installer', PLATFORM_SUPER_ADMIN: 'VOLTEX admin' };
const STATUS_LABEL: Record<string, string> = {
  pending: 'Waiting',
  active: 'Active',
  rejected: 'Rejected',
  revoked: 'Ended by you',
  expired: 'Expired',
  completed: 'Finished',
};

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const day = (ms: number) => new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' });

/** Support access: the owner approves, rejects or ends; everyone sees what is happening. */
export function SupportPanel() {
  const { isOwner } = useHub();
  const { pending, active, past, reload } = useGrants();

  return (
    <section aria-labelledby="support-title">
      <div className="section-title">
        <h2 id="support-title">VOLTEX support access</h2>
        <span>Nobody at VOLTEX can reach your home without your OK</span>
      </div>
      {pending.length === 0 && active.length === 0 && (
        <div className="card empty small">
          <p style={{ margin: 0 }}>No support session. If VOLTEX support needs to look at your hub, the request will appear here for {isOwner ? 'you' : 'the owner'} to approve.</p>
        </div>
      )}
      <div className="list-cards">
        {pending.map((g) => (
          <GrantCard key={g.grantId} grant={g} owner={isOwner} onChange={reload} />
        ))}
        {active.map((g) => (
          <GrantCard key={g.grantId} grant={g} owner={isOwner} onChange={reload} />
        ))}
      </div>
      {past.length > 0 && (
        <details className="card history">
          <summary>History ({past.length})</summary>
          <div className="list">
            {past.slice(0, 20).map((g) => (
              <div className="row" key={g.grantId}>
                <div className="row-main">
                  <p className="row-title">{g.staff.displayName}</p>
                  <p className="row-sub">
                    {day(g.requestedAt)} · {g.reason}
                    {g.endReason ? ` · ${g.endReason}` : ''}
                  </p>
                </div>
                <span className={`badge${g.status === 'rejected' || g.status === 'revoked' ? ' bad' : ' grey'}`}>{g.status === 'pending' || g.status === 'active' ? 'Expired' : STATUS_LABEL[g.status]}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

function GrantCard({ grant: g, owner, onChange }: { grant: GrantView; owner: boolean; onChange: () => void }) {
  const { api } = useHub();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const isActive = g.status === 'active';

  async function act(action: 'approve' | 'reject' | 'revoke') {
    if (action === 'revoke' && !confirm('End this support session now? Commands still queued are cancelled.')) return;
    setBusy(true);
    try {
      await api(`/support/grants/${g.grantId}/${action}`, { method: 'POST' });
      toast(action === 'approve' ? 'Support access approved' : action === 'reject' ? 'Request rejected' : 'Support session ended');
      onChange();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={`card grant${isActive ? ' live' : ''}`} aria-label={`Support ${isActive ? 'session' : 'request'} from ${g.staff.displayName}`}>
      <div className="grant-head">
        <span className="avatar">{g.staff.displayName.charAt(0).toUpperCase()}</span>
        <div className="row-main">
          <p className="row-title">{g.staff.displayName}</p>
          <p className="row-sub">{ROLE_LABEL[g.staff.role] ?? 'VOLTEX'}</p>
        </div>
        <span className={`badge${isActive ? '' : ' warn'}`}>{isActive ? `Active · ${timeLeft(g.endsAt)} left` : 'Needs your OK'}</span>
      </div>
      <p className="grant-reason">“{g.reason}”{g.ticketRef ? <span className="muted small"> · Ticket {g.ticketRef}</span> : null}</p>
      <dl className="grant-facts">
        <dt>Can</dt>
        <dd>
          <ul>
            {g.actions.map((a) => (
              <li key={a}>{GRANT_ACTION_LABEL[a] ?? a}</li>
            ))}
          </ul>
        </dd>
        <dt>Devices</dt>
        <dd>{g.deviceIds.map(pretty).join(', ')}</dd>
        <dt>When</dt>
        <dd>
          {clock(g.startsAt)} – {clock(g.endsAt)}
          {day(g.startsAt) !== day(Date.now()) ? ` (${day(g.startsAt)})` : ''}
        </dd>
      </dl>
      {owner ? (
        <div className="grant-actions">
          {isActive ? (
            <button className="btn danger" disabled={busy} onClick={() => void act('revoke')}>
              End session now
            </button>
          ) : (
            <>
              <button className="btn" disabled={busy} onClick={() => void act('approve')}>
                Approve
              </button>
              <button className="btn ghost" disabled={busy} onClick={() => void act('reject')}>
                Reject
              </button>
            </>
          )}
        </div>
      ) : (
        <p className="small muted" style={{ margin: '10px 0 0' }}>
          Only the home owner can approve or end support access.
        </p>
      )}
    </article>
  );
}
