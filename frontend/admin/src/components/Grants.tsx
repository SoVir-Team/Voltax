'use client';

import { GRANT_ACTIONS, platformScope, type CloudGrantView, type Diagnostics, type GrantAction, type GrantCommandView, type NotificationView } from '@voltax/contracts';
import { useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { ago, dateTime, GRANT_ACTION_LABEL } from '@/lib/format';
import { useSession } from './Session';
import { Badge, Card, Empty, Facts, ReasonAction, useAction, useLoad } from './ui';

const STATUS_TEXT: Record<string, string> = {
  pending: 'Waiting for the owner',
  active: 'Active',
  rejected: 'Owner said no',
  revoked: 'Revoked',
  expired: 'Expired',
  completed: 'Completed',
};

export function GrantStatus({ g }: { g: CloudGrantView }) {
  return <Badge status={g.status}>{STATUS_TEXT[g.status] ?? g.status}</Badge>;
}

/**
 * One support grant. Requests are approved by the home owner on their hub, never here. While a grant
 * is active, its requester gets only the tools the owner approved; the hub re-checks every action.
 */
export function GrantCard({ g, onChange }: { g: CloudGrantView; onChange(): void }) {
  const { me, can } = useSession();
  const { run } = useAction();
  const mine = g.staff.staffId === me?.staff.staffId;
  const open = g.status === 'pending' || g.status === 'active';
  const canRevoke = open && can('grant.revoke') && (me?.staff.role === 'PLATFORM_SUPER_ADMIN' || mine);
  const base = `/homes/${g.homeId}/grants/${g.grantId}`;
  const [history, setHistory] = useState(false);

  return (
    <Card className={g.status === 'active' ? 'live' : ''}>
      <div className="card-head">
        <h2>{g.reason}</h2>
        <GrantStatus g={g} />
      </div>
      <Facts
        rows={[
          ['Requested by', `${g.staff.displayName}${mine ? ' (you)' : ''}`],
          ['Ticket', g.ticketRef ?? '—'],
          ['Window', `${dateTime(g.startsAt)} – ${dateTime(g.endsAt)}`],
          ['Allowed', g.actions.map((a) => GRANT_ACTION_LABEL[a] ?? a).join(', ')],
          ['Devices', g.deviceIds.join(', ')],
          ['Owner notified', g.ownerNotified ? `Yes, ${dateTime(g.startNoticeAt)}` : g.status === 'active' ? 'Not yet: control is blocked until delivered' : '—'],
          ...(g.endedAt ? ([['Ended', `${dateTime(g.endedAt)}${g.endReason ? ` · ${g.endReason}` : ''}`]] as [string, string][]) : []),
        ]}
      />
      {canRevoke && (
        <div className="row-actions flat">
          {mine && g.status === 'active' && (
            <ReasonAction
              label="Finish session"
              confirmLabel="Finish"
              onSubmit={(reason) =>
                run(
                  () =>
                    api(`${base}/revoke`, {
                      method: 'POST',
                      body: { reason, outcome: 'completed' },
                    }),
                  'Session finished',
                ).then((ok) => (ok && onChange(), ok))
              }
            />
          )}
          <ReasonAction
            label={g.status === 'pending' ? 'Withdraw request' : 'Revoke access'}
            confirmLabel="Revoke"
            danger
            onSubmit={(reason) =>
              run(
                () =>
                  api(`${base}/revoke`, {
                    method: 'POST',
                    body: { reason, outcome: 'revoked' },
                  }),
                'Access revoked',
              ).then((ok) => (ok && onChange(), ok))
            }
          />
        </div>
      )}
      {g.status === 'active' && mine && <GrantTools g={g} />}
      {/* Mounted only while open, so each opening shows the latest results. */}
      <details style={{ marginTop: 12 }} onToggle={(e) => setHistory(e.currentTarget.open)}>
        <summary className="small">History: commands and owner notifications</summary>
        {history && <GrantHistory g={g} showNotifications={can('notification.read')} />}
      </details>
    </Card>
  );
}

/** Only for the requester of an active grant, and only the actions the owner approved. */
function GrantTools({ g }: { g: CloudGrantView }) {
  const { busy, run } = useAction();
  const [device, setDevice] = useState(g.deviceIds[0] ?? '');
  const [entity, setEntity] = useState('relay');
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [activity, setActivity] = useState<Array<{
    seq: number;
    type: string;
    createdAt: number;
    payload: Record<string, unknown>;
  }> | null>(null);
  const [since, setSince] = useState(60);
  const base = `/homes/${g.homeId}/grants/${g.grantId}`;
  const allows = (a: GrantAction) => g.actions.includes(a);
  const command = (value: boolean) =>
    run(
      () =>
        api(`${base}/commands`, {
          method: 'POST',
          body: { entityId: `${device}.switch.${entity.trim()}`, value },
        }),
      `Sent: ${value ? 'on' : 'off'}. The hub checks the grant again before acting.`,
    );

  return (
    <div className="stack" style={{ marginTop: 14 }}>
      {allows('device.command') && (
        <div className="tool">
          <p className="row-title">Switch a device</p>
          <div className="form-row">
            <label className="field">
              Device
              <select value={device} onChange={(e) => setDevice(e.target.value)}>
                {g.deviceIds.map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
            </label>
            <label className="field">
              Switch name
              <input value={entity} pattern="[a-z0-9_-]+" onChange={(e) => setEntity(e.target.value.toLowerCase())} />
            </label>
          </div>
          <div className="row-actions flat">
            <button className="btn sm" disabled={busy || !entity} onClick={() => void command(true)}>
              Turn on
            </button>
            <button className="btn sm ghost" disabled={busy || !entity} onClick={() => void command(false)}>
              Turn off
            </button>
          </div>
        </div>
      )}
      {allows('diagnostics.read') && (
        <div className="tool">
          <div className="row-actions">
            <p className="row-title" style={{ flex: 1 }}>
              Diagnostics
            </p>
            <button
              className="btn sm secondary"
              disabled={busy}
              onClick={() =>
                void run(async () =>
                  setDiagnostics(
                    await api<Diagnostics>(`${base}/diagnostics`, {
                      method: 'POST',
                    }),
                  ),
                )
              }
            >
              Fetch
            </button>
          </div>
          {diagnostics && (
            <Facts
              rows={[
                ['Hub version', diagnostics.version],
                ['Uptime', `${Math.round(diagnostics.uptime / 3600)} h`],
                ['Database', diagnostics.db],
                ['Device network', diagnostics.mqtt],
                ['Clock synced', diagnostics.timeSynced ? 'yes' : 'no'],
                ['Devices online', `${diagnostics.devices.filter((d) => d.online).length}/${diagnostics.devices.length}`],
                ['Commands (24 h)', `${diagnostics.commandsLast24h.confirmed} ok · ${diagnostics.commandsLast24h.failed} failed · ${diagnostics.commandsLast24h.expired} expired`],
              ]}
            />
          )}
        </div>
      )}
      {allows('activity.read') && (
        <div className="tool">
          <div className="row-actions">
            <p className="row-title" style={{ flex: 1 }}>
              Recent activity <span className="small muted">(passes through, not stored in the cloud)</span>
            </p>
            <select aria-label="Period" value={since} onChange={(e) => setSince(Number(e.target.value))} style={{ width: 'auto' }}>
              <option value={60}>Last hour</option>
              <option value={24 * 60}>Last day</option>
              <option value={7 * 24 * 60}>Last week</option>
            </select>
            <button
              className="btn sm secondary"
              disabled={busy}
              onClick={() =>
                void run(async () =>
                  setActivity(
                    await api(`${base}/activity`, {
                      method: 'POST',
                      body: { sinceMinutes: since },
                    }),
                  ),
                )
              }
            >
              Fetch
            </button>
          </div>
          {activity && (
            <div className="list">
              {activity.length === 0 && <Empty>No activity in that period.</Empty>}
              {activity.slice(-50).map((e) => (
                <div className="row" key={e.seq}>
                  <div className="row-main">
                    <p className="row-title mono">{e.type}</p>
                    <p className="row-sub">{dateTime(e.createdAt)}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {allows('hub.restart') && (
        <div className="tool row-actions">
          <p className="row-title" style={{ flex: 1 }}>
            Restart the hub
          </p>
          <button
            className="btn sm danger"
            disabled={busy}
            onClick={() => {
              if (confirm('Restart this hub? Devices keep working; the app reconnects in about a minute.'))
                void run(() => api(`${base}/restart`, { method: 'POST' }), 'Restart sent');
            }}
          >
            Restart
          </button>
        </div>
      )}
    </div>
  );
}

function GrantHistory({ g, showNotifications }: { g: CloudGrantView; showNotifications: boolean }) {
  const base = `/homes/${g.homeId}/grants/${g.grantId}`;
  const commands = useLoad(() => api<GrantCommandView[]>(`${base}/commands`), [base]);
  const notes = useLoad(() => (showNotifications ? api<NotificationView[]>(`${base}/notifications`) : Promise.resolve([])), [base, showNotifications]);
  return (
    <div className="list">
      {(commands.data ?? []).map((c) => (
        <div className="row" key={c.commandId}>
          <div className="row-main">
            <p className="row-title mono">
              {c.entityId} → {c.value ? 'on' : 'off'}
            </p>
            <p className="row-sub">
              {dateTime(c.requestedAt)}
              {c.reason ? ` · ${c.reason}` : ''}
            </p>
          </div>
          <Badge status={c.status} />
        </div>
      ))}
      {(notes.data ?? []).map((n) => (
        <div className="row" key={n.id}>
          <div className="row-main">
            <p className="row-title">
              Owner notice: {n.kind === 'support.started' ? 'session started' : 'session ended'} ({n.channel === 'in_app' ? 'on the hub' : 'email'})
            </p>
            <p className="row-sub">
              {n.attempts} {n.attempts === 1 ? 'attempt' : 'attempts'} · {n.deliveredAt ? `delivered ${ago(n.deliveredAt)}` : (n.lastError ?? 'not delivered yet')}
            </p>
          </div>
          <Badge status={n.status} />
        </div>
      ))}
      {commands.data?.length === 0 && notes.data?.length === 0 && <Empty>Nothing yet.</Empty>}
    </div>
  );
}

/** Ask the owner for time-limited access. The owner decides on their hub app. */
export function RequestGrant({ homeId, devices, onDone }: { homeId: string; devices: string[]; onDone(): void }) {
  const { me } = useSession();
  const { busy, run } = useAction();
  const offered = GRANT_ACTIONS.filter((a) => me && platformScope(me.staff.role, a) !== null);
  const [actions, setActions] = useState<GrantAction[]>(['diagnostics.read']);
  const [chosen, setChosen] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [ticket, setTicket] = useState('');
  const [minutes, setMinutes] = useState(60);
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await run(
      () =>
        api(`/homes/${homeId}/grants`, {
          method: 'POST',
          body: {
            deviceIds: chosen,
            actions,
            reason,
            ticketRef: ticket.trim() || undefined,
            durationMinutes: minutes,
          },
        }),
      'Request sent. The owner approves it on their VOLTEX app.',
    );
    if (ok) {
      setReason('');
      setTicket('');
      onDone();
    }
  }

  if (devices.length === 0) return <Empty>This home has no devices reported yet, so there is nothing to request access to.</Empty>;
  return (
    <form className="form" onSubmit={(e) => void submit(e)}>
      <div className="field">
        What you need
        <div className="checks">
          {offered.map((a) => (
            <label className="check" key={a}>
              <input type="checkbox" checked={actions.includes(a)} onChange={() => setActions(toggle(actions, a))} />
              {GRANT_ACTION_LABEL[a]}
            </label>
          ))}
        </div>
      </div>
      <div className="field">
        Devices
        <div className="checks">
          {devices.map((d) => (
            <label className="check" key={d}>
              <input type="checkbox" checked={chosen.includes(d)} onChange={() => setChosen(toggle(chosen, d))} />
              <span className="mono">{d}</span>
            </label>
          ))}
        </div>
      </div>
      <label className="field">
        Reason <span className="hint">the owner sees this</span>
        <input
          required
          minLength={10}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Kitchen switch stopped responding; checking its connection"
        />
      </label>
      <div className="form-row">
        <label className="field">
          Ticket <span className="hint">optional</span>
          <input maxLength={64} value={ticket} onChange={(e) => setTicket(e.target.value)} />
        </label>
        <label className="field">
          For how long
          <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
            {[15, 30, 60, 120, 240].map((m) => (
              <option key={m} value={m}>
                {m < 60 ? `${m} minutes` : `${m / 60} ${m === 60 ? 'hour' : 'hours'}`}
              </option>
            ))}
          </select>
        </label>
      </div>
      <button className="btn" disabled={busy || actions.length === 0 || chosen.length === 0 || reason.trim().length < 10}>
        Ask the owner
      </button>
    </form>
  );
}
