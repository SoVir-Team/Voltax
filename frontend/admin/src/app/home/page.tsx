'use client';

import type { AssignmentView, CloudGrantView, HomeView, HubEnrolment, StaffView } from '@voltax/contracts';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { GrantCard, RequestGrant } from '@/components/Grants';
import { useSession } from '@/components/Session';
import { Badge, Card, Empty, Facts, Page, SecretBox, Table, useAction, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { ago, dateTime } from '@/lib/format';
import { ROLE_LABEL } from '@/lib/nav';

export default function HomePage() {
  return (
    <Suspense fallback={null}>
      <HomeDetail />
    </Suspense>
  );
}

function HomeDetail() {
  const id = useSearchParams().get('id') ?? '';
  const { me, can } = useSession();
  const home = useLoad(() => api<HomeView>(`/homes/${id}`), [id]);
  const devices = useLoad(() => (can('device.read') ? api<Array<{ deviceId: string; online: boolean }>>(`/homes/${id}/devices`) : Promise.resolve([])), [id]);
  const grants = useLoad(() => (can('grant.read') ? api<CloudGrantView[]>(`/homes/${id}/grants`) : Promise.resolve([])), [id]);
  const h = home.data;
  const openGrants = (grants.data ?? []).filter((g) => g.status === 'pending' || g.status === 'active');

  // The owner decides (and can end access) on their hub at any moment: refresh while anything is open.
  const { reload: reloadGrants } = grants;
  useEffect(() => {
    if (openGrants.length === 0) return;
    const timer = setInterval(() => void reloadGrants(), 5000);
    return () => clearInterval(timer);
  }, [openGrants.length, reloadGrants]);

  if (home.error)
    return (
      <Page title="Home not found" back={{ href: '/homes/', label: 'Homes' }}>
        {<Empty>It does not exist or is not assigned to you.</Empty>}
      </Page>
    );
  if (!h) return null;
  const open = openGrants;
  const past = (grants.data ?? []).filter((g) => !open.includes(g));
  const myOpen = open.some((g) => g.staff.staffId === me?.staff.staffId);

  return (
    <Page eyebrow="Home" title={h.name} back={{ href: '/homes/', label: 'Homes' }}>
      <div className="cols">
        <div className="stack">
          <Card title="Hub" aside={h.hub && <Badge status={h.hub.online ? 'ok' : 'error'}>{h.hub.online ? 'online' : 'offline'}</Badge>}>
            {h.hub ? (
              <Facts
                rows={[
                  [
                    'Hub id',
                    <span className="mono" key="id">
                      {h.hub.hubId}
                    </span>,
                  ],
                  ['Last seen', ago(h.hub.lastSeenAt)],
                  ['Version', h.hub.version ?? '—'],
                  ['Clock', h.hub.timeSynced === null ? '—' : h.hub.timeSynced ? 'Synced' : 'Not synced'],
                  ['Update', h.hub.update ? `${h.hub.update.state}${h.hub.update.version ? ` (${h.hub.update.version})` : ''}` : '—'],
                  ['Devices', `${h.hub.devicesOnline}/${h.hub.devicesTotal} online`],
                  ['Registered', dateTime(h.hub.registeredAt)],
                ]}
              />
            ) : (
              <Empty>No hub registered for this home yet.</Empty>
            )}
            {can('hub.register') && <RegisterHub homeId={h.homeId} current={h.hub?.hubId ?? null} onDone={() => void home.reload()} />}
          </Card>

          {can('home.onboard') && h.hub && <OwnerOnboarding homeId={h.homeId} />}

          {can('grant.read') && (
            <section id="grants" className="stack">
              {open.map((g) => (
                <GrantCard key={g.grantId} g={g} onChange={() => void grants.reload()} />
              ))}
              {can('grant.request') && !myOpen && (
                <Card title="Request support access">
                  <p className="small muted" style={{ marginTop: 0 }}>
                    The owner gets the request on their VOLTEX app and decides there. Nothing is possible until they approve, and they can end it at any time.
                  </p>
                  <RequestGrant homeId={h.homeId} devices={(devices.data ?? []).map((d) => d.deviceId)} onDone={() => void grants.reload()} />
                </Card>
              )}
              {past.length > 0 && (
                <Card title="Earlier requests">
                  <Table
                    head={['Reason', 'By', 'Status', 'Ended']}
                    rows={past.map((g) => (
                      <tr key={g.grantId}>
                        <td>{g.reason}</td>
                        <td>{g.staff.displayName}</td>
                        <td>
                          <Badge status={g.status} />
                        </td>
                        <td>{dateTime(g.endedAt ?? g.endsAt)}</td>
                      </tr>
                    ))}
                  />
                </Card>
              )}
            </section>
          )}
        </div>

        <div className="stack">
          {can('device.read') && (
            <Card title="Devices" aside={<span className="small muted">online/offline only</span>}>
              <div className="list">
                {(devices.data ?? []).map((d) => (
                  <div className="row" key={d.deviceId}>
                    <span className={`dot ${d.online ? 'ok' : 'bad'}`} aria-hidden="true" />
                    <p className="row-title mono row-main">{d.deviceId}</p>
                    <span className="small muted">{d.online ? 'online' : 'offline'}</span>
                  </div>
                ))}
                {devices.data?.length === 0 && <Empty>No devices reported.</Empty>}
              </div>
            </Card>
          )}
          {can('home.update') && <EditHome home={h} onDone={() => void home.reload()} />}
          {can('home.contact.read') && <OwnerContact homeId={h.homeId} />}
          {can('assignment.manage') && <Assignments homeId={h.homeId} />}
          {can('audit.read') && h.hub && <HubAudit homeId={h.homeId} />}
        </div>
      </div>
    </Page>
  );
}

function RegisterHub({ homeId, current, onDone }: { homeId: string; current: string | null; onDone(): void }) {
  const { busy, run } = useAction();
  const [hubId, setHubId] = useState(current ?? '');
  const [enrolment, setEnrolment] = useState<HubEnrolment | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (current && !confirm('Issue new cloud credentials for this hub? The old password stops working at once.')) return;
    const ok = await run(async () =>
      setEnrolment(
        await api<HubEnrolment>(`/homes/${homeId}/hub`, {
          method: 'POST',
          body: { hubId },
        }),
      ),
    );
    if (ok) onDone();
  }

  return (
    <details style={{ marginTop: 14 }} open={!current}>
      <summary className="small">{current ? 'Re-issue cloud credentials' : 'Register the hub'}</summary>
      <form className="form" style={{ marginTop: 10 }} onSubmit={(e) => void submit(e)}>
        <label className="field">
          Hub id <span className="hint">printed by the hub installer (lowercase letters, digits, dashes)</span>
          <input required pattern="[a-z0-9][a-z0-9-]{2,63}" value={hubId} readOnly={!!current} onChange={(e) => setHubId(e.target.value.trim().toLowerCase())} />
        </label>
        <button className="btn sm" disabled={busy}>
          {current ? 'Issue new credentials' : 'Register'}
        </button>
      </form>
      {enrolment && (
        <SecretBox
          title="Cloud link settings for this hub (shown once)"
          value={[`HUB_ID=${enrolment.hubId}`, `CLOUD_URL=${enrolment.brokerUrl ?? '<broker URL>'}`, `CLOUD_PASSWORD=${enrolment.brokerPassword}`].join('\n')}
          note="Put these in the hub's hub.env as described in the cloud-link runbook, together with the cloud's command public key. This password is not stored in readable form and cannot be shown again."
        />
      )}
    </details>
  );
}

function EditHome({ home, onDone }: { home: HomeView; onDone(): void }) {
  const { busy, run } = useAction();
  const [name, setName] = useState(home.name);
  const [contact, setContact] = useState('');
  return (
    <Card title="Edit home">
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          const body: Record<string, unknown> = {};
          if (name.trim() !== home.name) body.name = name.trim();
          if (contact.trim()) body.ownerContact = contact.trim();
          if (Object.keys(body).length) void run(() => api(`/homes/${home.homeId}`, { method: 'PATCH', body }), 'Saved').then((ok) => ok && (setContact(''), onDone()));
        }}
      >
        <label className="field">
          Name
          <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          New owner contact email <span className="hint">leave empty to keep the current one</span>
          <input type="email" maxLength={254} value={contact} onChange={(e) => setContact(e.target.value)} />
        </label>
        <button className="btn sm" disabled={busy}>
          Save
        </button>
      </form>
    </Card>
  );
}

/** Personal data: fetched only on request, and every view is audited. */
function OwnerContact({ homeId }: { homeId: string }) {
  const { busy, run } = useAction();
  const [contact, setContact] = useState<string | null | undefined>(undefined);
  return (
    <Card title="Owner contact">
      {contact === undefined ? (
        <>
          <p className="small muted" style={{ marginTop: 0 }}>
            Only look this up when you need to reach the owner. Each view is recorded.
          </p>
          <button
            className="btn sm secondary"
            disabled={busy}
            onClick={() => void run(async () => setContact((await api<{ ownerContact: string | null }>(`/homes/${homeId}/contact`)).ownerContact))}
          >
            Show contact
          </button>
        </>
      ) : (
        <p style={{ margin: 0 }}>{contact ?? <span className="muted">No contact on file.</span>}</p>
      )}
    </Card>
  );
}

function Assignments({ homeId }: { homeId: string }) {
  const { busy, run } = useAction();
  const list = useLoad(() => api<AssignmentView[]>(`/assignments?homeId=${homeId}`), [homeId]);
  const staff = useLoad(() => api<StaffView[]>('/staff'));
  const [staffId, setStaffId] = useState('');
  const [days, setDays] = useState(0);
  const byId = new Map((staff.data ?? []).map((s) => [s.staffId, s]));
  const eligible = (staff.data ?? []).filter((s) => s.role !== 'PLATFORM_SUPER_ADMIN' && !s.disabled && !(list.data ?? []).some((a) => a.staffId === s.staffId));

  return (
    <Card title="Assigned staff">
      <div className="list">
        {(list.data ?? []).map((a) => {
          const s = byId.get(a.staffId);
          return (
            <div className="row" key={a.assignmentId}>
              <div className="row-main">
                <p className="row-title">{s?.displayName ?? a.staffId}</p>
                <p className="row-sub">
                  {s ? ROLE_LABEL[s.role] : ''} · {a.expiresAt ? `until ${dateTime(a.expiresAt)}` : 'no end date'}
                </p>
              </div>
              <button
                className="btn sm ghost"
                disabled={busy}
                onClick={() =>
                  void run(
                    () =>
                      api(`/assignments/${a.assignmentId}`, {
                        method: 'DELETE',
                      }),
                    'Assignment removed',
                  ).then((ok) => {
                    if (ok) void list.reload();
                  })
                }
              >
                Remove
              </button>
            </div>
          );
        })}
        {list.data?.length === 0 && <Empty>Nobody is assigned. Support staff and installers see only homes assigned to them.</Empty>}
      </div>
      <form
        className="form-row"
        style={{ marginTop: 12, alignItems: 'end' }}
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            () =>
              api('/assignments', {
                method: 'POST',
                body: {
                  staffId,
                  homeId,
                  expiresAt: days ? Date.now() + days * 86_400_000 : null,
                },
              }),
            'Assigned',
          ).then((ok) => {
            if (!ok) return;
            setStaffId('');
            void list.reload();
          });
        }}
      >
        <label className="field">
          Assign
          <select required value={staffId} onChange={(e) => setStaffId(e.target.value)}>
            <option value="">Choose staff…</option>
            {eligible.map((s) => (
              <option key={s.staffId} value={s.staffId}>
                {s.displayName} ({ROLE_LABEL[s.role]})
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          For
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={0}>No end date</option>
            <option value={1}>1 day</option>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
          </select>
        </label>
        <button className="btn sm" disabled={busy || !staffId}>
          Assign
        </button>
      </form>
    </Card>
  );
}

interface HubAuditView {
  summary: { records: number; lastSeq: number; breaks: number };
  records: Array<{
    seq: number;
    at: number;
    actor: string;
    action: string;
    outcome: string;
    target: string | null;
    chainOk: boolean;
  }>;
}

/** The hub's own audit chain, copied to the cloud: an off-device record the hub cannot rewrite. */
function HubAudit({ homeId }: { homeId: string }) {
  const audit = useLoad(() => api<HubAuditView>(`/homes/${homeId}/hub/audit`), [homeId]);
  const a = audit.data;
  return (
    <Card title="Hub audit copy" aside={a && <Badge status={a.summary.breaks ? 'error' : 'ok'}>{a.summary.breaks ? `${a.summary.breaks} chain breaks` : 'chain intact'}</Badge>}>
      {a && (
        <>
          <p className="small muted" style={{ marginTop: 0 }}>
            {a.summary.records} records received, up to #{a.summary.lastSeq}.
          </p>
          <Table
            head={['#', 'When', 'Action', 'Outcome']}
            rows={a.records
              .slice(-30)
              .reverse()
              .map((r) => (
                <tr key={r.seq}>
                  <td>{r.seq}</td>
                  <td>{dateTime(r.at)}</td>
                  <td className="mono">
                    {r.action}
                    {!r.chainOk && <span className="bad-text"> · chain break</span>}
                  </td>
                  <td>
                    <Badge status={r.outcome} />
                  </td>
                </tr>
              ))}
          />
        </>
      )}
    </Card>
  );
}

function OwnerOnboarding({ homeId }: { homeId: string }) {
  const status = useLoad(() => api<{ available: boolean; claimed: boolean | null }>(`/homes/${homeId}/onboarding`), [homeId]);
  const [email, setEmail] = useState('');
  const [result, setResult] = useState<{ code: string; expiresAt: number; email: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function generate(e: FormEvent) {
    e.preventDefault(); setError(null); setResult(null); setBusy(true);
    try {
      setResult(await api(`/homes/${homeId}/onboarding`, { method: 'POST', body: { email } }));
      void status.reload();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return <Card title="Homeowner setup">
    {status.data?.claimed ? <p className="small muted">The homeowner has created their account. Family access is managed in the customer app.</p> : <form className="form" onSubmit={e => void generate(e)}>
      <p className="small muted">Generate a one-time code for the homeowner. They use it to create their customer account. A new code replaces the previous unused code.</p>
      {status.data && !status.data.available && <p className="note">The home hub is not connected right now. Start it and wait about a minute before generating a code.</p>}
      <label className="field">Homeowner email<input type="email" autoComplete="email" required maxLength={254} value={email} onChange={e => setEmail(e.target.value)} /></label>
      {error && <p className="note" role="alert">{error}</p>}
      <button className="btn" disabled={busy}>{busy ? 'Requesting code…' : 'Generate homeowner code'}</button>
    </form>}
    {result && <SecretBox title="One-time homeowner code" value={result.code} note={`For ${result.email}. Expires ${dateTime(result.expiresAt)}. Copy and give it to the homeowner. Keep it private.`} />}
  </Card>;
}
