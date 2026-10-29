'use client';

import type { RolloutView } from '@voltax/contracts';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';
import { useSession } from '@/components/Session';
import { Badge, Card, Empty, Facts, Page, ReasonAction, Table, useAction, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { ago, dateTime, progress } from '@/lib/format';

export default function RolloutPage() {
  return (
    <Suspense fallback={null}>
      <RolloutDetail />
    </Suspense>
  );
}

function RolloutDetail() {
  const id = useSearchParams().get('id') ?? '';
  const { can } = useSession();
  const { run } = useAction();
  const rollout = useLoad(() => api<RolloutView>(`/rollouts/${id}`), [id]);
  const running = rollout.data?.status === 'running';
  const { reload } = rollout;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void reload(), 5000);
    return () => clearInterval(timer);
  }, [running, reload]);
  const r = rollout.data;
  if (rollout.error)
    return (
      <Page title="Rollout not found" back={{ href: '/fleet/', label: 'Fleet' }}>
        {<Empty>It does not exist.</Empty>}
      </Page>
    );
  if (!r) return null;

  const act = (verb: 'halt' | 'resume' | 'cancel', done: string) => (reason: string) =>
    run(
      () =>
        api(`/rollouts/${r.rolloutId}/${verb}`, {
          method: 'POST',
          body: { reason },
        }),
      done,
    ).then((ok) => (ok && void rollout.reload(), ok));
  const open = r.status === 'running' || r.status === 'halted';

  return (
    <Page
      eyebrow="Rollout"
      title={`Version ${r.release.version}`}
      back={{ href: '/fleet/', label: 'Fleet' }}
      actions={
        can('rollout.manage') &&
        open && (
          <div className="row-actions">
            {r.status === 'running' && <ReasonAction label="Halt" onSubmit={act('halt', 'Rollout halted: no new offers')} />}
            {r.status === 'halted' && <ReasonAction label="Resume" onSubmit={act('resume', 'Rollout resumed')} />}
            <ReasonAction label="Cancel rollout" confirmLabel="Cancel rollout" danger onSubmit={act('cancel', 'Rollout cancelled')} />
          </div>
        )
      }
    >
      {r.haltReason && r.status === 'halted' && <p className="note">Halted: {r.haltReason}</p>}
      <div className="stack">
        <Card title="Plan" aside={<Badge status={r.status} />}>
          <Facts
            rows={[
              ['Current stage', r.stage === 0 ? 'Canary (1 hub)' : `${r.stages[r.stage - 1]}% of eligible hubs`],
              ['Stages', ['canary', ...r.stages.map((s) => `${s}%`)].join(' → ')],
              ['Halts above', `${Math.round(r.maxFailureRate * 100)}% failed`],
              ['Each stage runs', `${r.healthWindowMinutes} min`],
              ['Stage started', ago(r.stageStartedAt)],
              [
                'Release',
                <Link key="rel" href="/releases/">
                  {r.release.version}
                </Link>,
              ],
              ['Progress', progress(r)],
              ['Created', dateTime(r.createdAt)],
            ]}
          />
        </Card>
        <Card title="Hubs">
          <Table
            head={['Hub', 'Stage', 'State', 'From', 'Detail', 'Updated']}
            empty="No hubs targeted yet."
            rows={(r.targets ?? []).map((t) => (
              <tr key={t.hubId}>
                <td>
                  <Link className="mono" href={`/home/?id=${t.homeId}`}>
                    {t.hubId}
                  </Link>
                </td>
                <td>{t.stage < 0 ? '—' : t.stage === 0 ? 'canary' : `${r.stages[t.stage - 1]}%`}</td>
                <td>
                  <Badge status={t.state} />
                </td>
                <td>{t.fromVersion ?? '—'}</td>
                <td className="small">{t.detail ?? ''}</td>
                <td>{ago(t.updatedAt)}</td>
              </tr>
            ))}
          />
        </Card>
      </div>
    </Page>
  );
}
