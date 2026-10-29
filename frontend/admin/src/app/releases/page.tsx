'use client';

import type { HubCompatibility, ReleaseView } from '@voltax/contracts';
import { useState, type FormEvent } from 'react';
import { useSession } from '@/components/Session';
import { Badge, Card, Page, ReasonAction, Table, useAction, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';

/** Signed hub releases and ESP32 firmware. The cloud accepts only manifests signed by the release key. */
export default function ReleasesPage() {
  const { can } = useSession();
  const { run } = useAction();
  const releases = useLoad(() => api<ReleaseView[]>('/releases'));
  const [checking, setChecking] = useState<string | null>(null);

  return (
    <Page eyebrow="Signed and verified on upload" title="Releases">
      <div className="stack">
        <div className="stack">
          <Card>
            <Table
              head={['Version', 'Kind', 'Signed with', 'Added', 'Status', '']}
              empty={releases.data ? 'No releases registered.' : 'Loading…'}
              rows={(releases.data ?? []).map((r) => (
                <tr key={r.releaseId}>
                  <td>
                    <b>{r.version}</b>
                    {r.notes && <p className="row-sub">{r.notes}</p>}
                    {r.minFromVersion && <p className="row-sub">Needs {r.minFromVersion} or later installed first</p>}
                  </td>
                  <td>{r.kind === 'hub' ? 'Hub' : `ESP32 (${r.board})`}</td>
                  <td className="mono small" title={r.trustedComment}>
                    {r.keyId}
                  </td>
                  <td>{dateTime(r.createdAt)}</td>
                  <td>{r.withdrawnAt ? <Badge status="error">withdrawn</Badge> : <Badge status="ok">available</Badge>}</td>
                  <td>
                    <div className="row-actions">
                      {r.kind === 'hub' && can('rollout.read') && (
                        <button className="btn sm ghost" onClick={() => setChecking(checking === r.releaseId ? null : r.releaseId)}>
                          Which hubs?
                        </button>
                      )}
                      {!r.withdrawnAt && can('firmware.manage') && (
                        <ReasonAction
                          label="Withdraw"
                          danger
                          onSubmit={(reason) =>
                            run(
                              () =>
                                api(`/releases/${r.releaseId}/withdraw`, {
                                  method: 'POST',
                                  body: { reason },
                                }),
                              'Withdrawn: running rollouts of it halt',
                            ).then((ok) => (ok && void releases.reload(), ok))
                          }
                        />
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            />
          </Card>
          {checking && <Compatibility releaseId={checking} />}
        </div>
        {can('firmware.manage') && <RegisterRelease onDone={() => void releases.reload()} />}
      </div>
    </Page>
  );
}

function Compatibility({ releaseId }: { releaseId: string }) {
  const list = useLoad(() => api<HubCompatibility[]>(`/releases/${releaseId}/compatibility`), [releaseId]);
  const eligible = (list.data ?? []).filter((h) => h.eligible).length;
  return (
    <Card title="Hub compatibility" aside={list.data && <span className="small muted">{eligible} eligible</span>}>
      <Table
        head={['Hub', 'Installed', 'Eligible', 'Why']}
        empty="No hubs registered."
        rows={(list.data ?? []).map((h) => (
          <tr key={h.hubId}>
            <td className="mono">{h.hubId}</td>
            <td>{h.currentVersion ?? '—'}</td>
            <td>
              <Badge status={h.eligible ? 'eligible' : 'grey'}>{h.eligible ? 'yes' : 'no'}</Badge>
            </td>
            <td className="small">{h.reason}</td>
          </tr>
        ))}
      />
    </Card>
  );
}

function RegisterRelease({ onDone }: { onDone(): void }) {
  const { busy, run } = useAction();
  const [kind, setKind] = useState<'hub' | 'esp32'>('hub');
  const [manifest, setManifest] = useState('');
  const [signature, setSignature] = useState('');
  const [minFrom, setMinFrom] = useState('');
  const [notes, setNotes] = useState('');

  const readFile = (set: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) void f.text().then(set);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await run(
      () =>
        api('/releases', {
          method: 'POST',
          body: {
            kind,
            manifest,
            signature,
            minFromVersion: minFrom.trim() || undefined,
            notes: notes.trim() || undefined,
          },
        }),
      'Signature verified. Release registered.',
    );
    if (ok) {
      setManifest('');
      setSignature('');
      setNotes('');
      onDone();
    }
  }

  return (
    <Card title="Register a release">
      <form className="form" onSubmit={(e) => void submit(e)}>
        <div className="segmented" role="radiogroup" aria-label="Kind">
          {(
            [
              ['hub', 'Hub release'],
              ['esp32', 'ESP32 firmware'],
            ] as const
          ).map(([v, l]) => (
            <button type="button" key={v} role="radio" aria-checked={kind === v} className={kind === v ? 'on' : ''} onClick={() => setKind(v)}>
              {l}
            </button>
          ))}
        </div>
        <label className="field">
          Manifest <span className="hint">{kind === 'hub' ? 'release.json from the release workflow' : 'firmware manifest JSON'}, exactly as signed</span>
          <input type="file" accept=".json,application/json" onChange={readFile(setManifest)} />
          <textarea required value={manifest} onChange={(e) => setManifest(e.target.value)} spellCheck={false} />
        </label>
        <label className="field">
          Signature <span className="hint">the .minisig file</span>
          <input type="file" accept=".minisig,text/plain" onChange={readFile(setSignature)} />
          <textarea required value={signature} onChange={(e) => setSignature(e.target.value)} spellCheck={false} style={{ minHeight: 80 }} />
        </label>
        <div className="form-row">
          <label className="field">
            Minimum installed version <span className="hint">optional</span>
            <input placeholder="1.2.0" value={minFrom} onChange={(e) => setMinFrom(e.target.value)} />
          </label>
          <label className="field">
            Notes <span className="hint">optional</span>
            <input maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
        </div>
        <button className="btn" disabled={busy || !manifest || !signature}>
          Verify and register
        </button>
      </form>
    </Card>
  );
}
