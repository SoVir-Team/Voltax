'use client';

import type { ReleaseView, RolloutView } from '@voltax/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useSession } from '@/components/Session';
import { Badge, Card, Page, Table, useAction, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime, progress } from '@/lib/format';

interface FleetSummary {
  hubs: number;
  online: number;
  versions: Record<string, number>;
  updateStates: Record<string, number>;
  activeRollout: string | null;
}

/** Staged hub rollouts: canary, then growing shares, halting on failures. Owners still decide per hub. */
export default function FleetPage() {
  const { can } = useSession();
  const summary = useLoad(() => api<FleetSummary>('/fleet/summary'));
  const rollouts = useLoad(() => api<RolloutView[]>('/rollouts'));
  const s = summary.data;

  return (
    <Page eyebrow="Hub software across all homes" title="Fleet">
      {s && (
        <div className="stats">
          <div className="stat">
            <b>{s.hubs}</b>
            <span>Hubs registered</span>
          </div>
          <div className="stat">
            <b>{s.online}</b>
            <span>Online now</span>
          </div>
          {Object.entries(s.updateStates)
            .filter(([k]) => k !== 'idle' && k !== 'unknown')
            .map(([k, n]) => (
              <div className="stat" key={k}>
                <b>{n}</b>
                <span>Update {k.replace(/_/g, ' ')}</span>
              </div>
            ))}
        </div>
      )}
      <div className="cols">
        <Card title="Rollouts">
          <Table
            head={['Release', 'Status', 'Stage', 'Progress', 'Started']}
            empty={rollouts.data ? 'No rollouts yet.' : 'Loading…'}
            rows={(rollouts.data ?? []).map((r) => (
              <tr key={r.rolloutId}>
                <td>
                  <Link href={`/rollout/?id=${r.rolloutId}`}>Version {r.release.version}</Link>
                </td>
                <td>
                  <Badge status={r.status} />
                </td>
                <td>{r.stage === 0 ? 'Canary' : `${r.stages[r.stage - 1] ?? 100}%`}</td>
                <td className="small">{progress(r)}</td>
                <td>{dateTime(r.createdAt)}</td>
              </tr>
            ))}
          />
        </Card>
        {can('hub.update') && <StartRollout active={s?.activeRollout ?? null} />}
      </div>
    </Page>
  );
}

function StartRollout({ active }: { active: string | null }) {
  const router = useRouter();
  const { busy, run } = useAction();
  const releases = useLoad(() => api<ReleaseView[]>('/releases'));
  const hubReleases = (releases.data ?? []).filter((r) => r.kind === 'hub' && !r.withdrawnAt);
  const [releaseId, setReleaseId] = useState('');
  const [stages, setStages] = useState('10, 50, 100');
  const [maxFail, setMaxFail] = useState(10);
  const [hours, setHours] = useState(1);

  async function submit(e: FormEvent) {
    e.preventDefault();
    let id = '';
    const ok = await run(async () => {
      const r = await api<RolloutView>('/rollouts', {
        method: 'POST',
        body: {
          releaseId,
          stages: stages
            .split(/[,\s]+/)
            .filter(Boolean)
            .map(Number),
          maxFailureRate: maxFail / 100,
          healthWindowMinutes: Math.round(hours * 60),
        },
      });
      id = r.rolloutId;
    }, 'Rollout started with a canary hub');
    if (ok) router.push(`/rollout/?id=${id}`);
  }

  if (active)
    return (
      <Card title="Start a rollout">
        <p className="small muted" style={{ margin: 0 }}>
          One rollout runs at a time. <Link href={`/rollout/?id=${active}`}>Open the current one</Link> to finish or cancel it first.
        </p>
      </Card>
    );
  return (
    <Card title="Start a rollout">
      <form className="form" onSubmit={(e) => void submit(e)}>
        <label className="field">
          Signed release
          <select required value={releaseId} onChange={(e) => setReleaseId(e.target.value)}>
            <option value="">Choose a hub release…</option>
            {hubReleases.map((r) => (
              <option key={r.releaseId} value={r.releaseId}>
                {r.version} · {dateTime(r.createdAt)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Stages after the canary <span className="hint">cumulative % of eligible hubs, ending at 100</span>
          <input value={stages} onChange={(e) => setStages(e.target.value)} />
        </label>
        <div className="form-row">
          <label className="field">
            Halt above <span className="hint">% failed</span>
            <input type="number" min={0} max={50} value={maxFail} onChange={(e) => setMaxFail(Number(e.target.value))} />
          </label>
          <label className="field">
            Each stage runs <span className="hint">hours</span>
            <input type="number" min={0.25} step={0.25} max={168} value={hours} onChange={(e) => setHours(Number(e.target.value))} />
          </label>
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          Hubs only receive an offer. Each home installs it under its owner&apos;s update setting, and a failed update rolls back on the hub.
        </p>
        <button className="btn" disabled={busy || !releaseId}>
          Start rollout
        </button>
      </form>
    </Card>
  );
}
