'use client';

import { PLATFORM_ROLES, type PlatformRole, type StaffView } from '@voltax/contracts';
import { useState, type FormEvent } from 'react';
import { useSession } from '@/components/Session';
import { Badge, Card, Page, SecretBox, Table, useAction, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { ROLE_LABEL } from '@/lib/nav';

const setupLink = (token: string) => `${location.origin}/setup/?token=${encodeURIComponent(token)}`;

/** Staff accounts. Each person uses their own email and password; no shared or default logins. */
export default function StaffPage() {
  const { me, can } = useSession();
  const { busy, run } = useAction();
  const staff = useLoad(() => api<StaffView[]>('/staff'));
  const [link, setLink] = useState<{ name: string; url: string } | null>(null);
  const manage = can('staff.manage');

  const patch = (s: StaffView, body: Record<string, unknown>, done: string) =>
    run(() => api(`/staff/${s.staffId}`, { method: 'PATCH', body }), done).then((ok) => {
      if (ok) void staff.reload();
    });

  async function reset(s: StaffView) {
    if (!confirm(`Reset ${s.displayName}'s password? They are signed out everywhere and need a new setup link.`)) return;
    await run(async () => {
      const { setupToken } = await api<{ setupToken: string }>(`/staff/${s.staffId}/reset`, { method: 'POST' });
      setLink({ name: s.displayName, url: setupLink(setupToken) });
    });
    void staff.reload();
  }

  const state = (s: StaffView) =>
    (s.disabled ? ['error', 'disabled'] : s.locked ? ['warn', 'locked'] : !s.setupComplete ? ['pending', 'setup pending'] : ['ok', 'active']) as [string, string];

  return (
    <Page eyebrow="Company accounts" title="Staff">
      {link && (
        <SecretBox
          title={`Setup link for ${link.name} (shown once)`}
          value={link.url}
          note="Send it to them privately. It works once and expires. Assign them to homes from each home's page."
        />
      )}
      <div className="cols">
        <Card>
          <Table
            head={['Name', 'Role', 'Status', 'Added', '']}
            empty={staff.data ? 'No staff.' : 'Loading…'}
            rows={(staff.data ?? []).map((s) => {
              const self = s.staffId === me?.staff.staffId;
              const [tone, label] = state(s);
              return (
                <tr key={s.staffId}>
                  <td>
                    <b>{s.displayName}</b>
                    {self && <span className="small muted"> (you)</span>}
                    <p className="row-sub">{s.email}</p>
                  </td>
                  <td>
                    {manage && !self ? (
                      <select
                        aria-label={`Role for ${s.displayName}`}
                        value={s.role}
                        disabled={busy}
                        onChange={(e) => void patch(s, { role: e.target.value }, 'Role changed. It applies on their next request.')}
                        style={{ width: 'auto' }}
                      >
                        {PLATFORM_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABEL[r]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      ROLE_LABEL[s.role]
                    )}
                  </td>
                  <td>
                    <Badge status={tone}>{label}</Badge>
                  </td>
                  <td className="small">{dateTime(s.createdAt)}</td>
                  <td>
                    {manage && !self && (
                      <div className="row-actions">
                        <button
                          className="btn sm ghost"
                          disabled={busy}
                          onClick={() => void patch(s, { disabled: !s.disabled }, s.disabled ? 'Account enabled' : 'Account disabled and signed out')}
                        >
                          {s.disabled ? 'Enable' : 'Disable'}
                        </button>
                        <button className="btn sm ghost" disabled={busy} onClick={() => void reset(s)}>
                          Reset login
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          />
        </Card>
        {manage && <AddStaff onCreated={(name, token) => (setLink({ name, url: setupLink(token) }), void staff.reload())} />}
      </div>
    </Page>
  );
}

function AddStaff({ onCreated }: { onCreated(name: string, token: string): void }) {
  const { busy, run } = useAction();
  const [email, setEmail] = useState('');
  const [displayName, setName] = useState('');
  const [role, setRole] = useState<PlatformRole>('PLATFORM_SUPPORT');

  async function submit(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      const { staff, setupToken } = await api<{
        staff: StaffView;
        setupToken: string;
      }>('/staff', { method: 'POST', body: { email, displayName, role } });
      onCreated(staff.displayName, setupToken);
      setEmail('');
      setName('');
    }, 'Account created');
  }

  return (
    <Card title="Add staff">
      <form className="form" onSubmit={(e) => void submit(e)}>
        <label className="field">
          Name
          <input required maxLength={80} value={displayName} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          Work email
          <input type="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          Role
          <select value={role} onChange={(e) => setRole(e.target.value as PlatformRole)}>
            {PLATFORM_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
        <p className="small muted" style={{ margin: 0 }}>
          Support and installers see only homes you assign them to, and can act in a home only with the owner&apos;s approval.
        </p>
        <button className="btn" disabled={busy}>
          Create and get setup link
        </button>
      </form>
    </Card>
  );
}
