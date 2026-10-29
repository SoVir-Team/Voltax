'use client';

import type { HomeView } from '@voltax/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useSession } from '@/components/Session';
import { Badge, Card, Page, Table, useAction, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';

/** Homes: operational metadata only (name, hub, connectivity, versions). Never device states or history. */
export default function HomesPage() {
  const { me, can } = useSession();
  const homes = useLoad(() => api<HomeView[]>('/homes'));
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const { run } = useAction();
  const canDelete = can('home.delete');

  /** Only a home that never went live can be deleted; the server enforces it too. */
  async function remove(h: HomeView) {
    if (!confirm(`Delete "${h.name}"? This cannot be undone.`)) return;
    if (await run(async () => { await api(`/homes/${h.homeId}`, { method: 'DELETE' }); }, 'Home deleted')) homes.reload();
  }
  const shown = (homes.data ?? []).filter((h) => !q || h.name.toLowerCase().includes(q) || h.hub?.hubId.includes(q));

  return (
    <Page
      eyebrow={me?.staff.role === 'PLATFORM_SUPER_ADMIN' ? 'All homes' : 'Homes you are assigned to'}
      title="Homes"
      actions={<input type="search" placeholder="Search name or hub id" aria-label="Search homes" value={query} onChange={(e) => setQuery(e.target.value)} />}
    >
      <div className="cols">
        <Card>
          <Table
            head={['Home', 'Hub', 'Status', 'Version', 'Devices', ...(canDelete ? [''] : [])]}
            empty={homes.data ? 'No homes match.' : 'Loading…'}
            rows={shown.map((h) => (
              <tr key={h.homeId}>
                <td>
                  <Link href={`/home/?id=${h.homeId}`}>{h.name}</Link>
                </td>
                <td className="mono">{h.hub?.hubId ?? <span className="muted">not registered</span>}</td>
                <td>
                  {h.hub ? (
                    <>
                      <Badge status={h.hub.online ? 'ok' : 'error'}>{h.hub.online ? 'online' : 'offline'}</Badge>
                      <span className="small muted"> {ago(h.hub.lastSeenAt)}</span>
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td>{h.hub?.version ?? '—'}</td>
                <td>{h.hub ? `${h.hub.devicesOnline}/${h.hub.devicesTotal} online` : '—'}</td>
                {canDelete && (
                  <td>
                    {!h.hub?.lastSeenAt && (
                      <button type="button" className="btn danger sm" onClick={() => void remove(h)}>
                        Delete
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          />
        </Card>
        {can('home.create') && <CreateHome />}
      </div>
    </Page>
  );
}

function CreateHome() {
  const router = useRouter();
  const { busy, run } = useAction();
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    let created: HomeView | null = null;
    const ok = await run(async () => {
      created = await api<HomeView>('/homes', {
        method: 'POST',
        body: { name, ownerContact: contact.trim() || null },
      });
    }, 'Home created');
    if (ok && created) router.push(`/home/?id=${(created as HomeView).homeId}`);
  }

  return (
    <Card title="Add a home">
      <form className="form" onSubmit={(e) => void submit(e)}>
        <label className="field">
          Name <span className="hint">shown to staff only, e.g. a customer reference</span>
          <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          Owner contact email <span className="hint">optional; used for support notifications</span>
          <input type="email" maxLength={254} value={contact} onChange={(e) => setContact(e.target.value)} />
        </label>
        <button className="btn" disabled={busy}>
          Add home
        </button>
      </form>
    </Card>
  );
}
