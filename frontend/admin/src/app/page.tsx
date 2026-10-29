'use client';

import type { CloudGrantView, HomeView } from '@voltax/contracts';
import Link from 'next/link';
import { useSession } from '@/components/Session';
import { Badge, Card, Empty, Page, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { ROLE_LABEL } from '@/lib/nav';

interface FleetSummary {
  hubs: number;
  online: number;
  versions: Record<string, number>;
  updateStates: Record<string, number>;
  activeRollout: string | null;
}

export default function Overview() {
  const { me, can } = useSession();
  const fleet = useLoad(() => (can('rollout.read') ? api<FleetSummary>('/fleet/summary') : Promise.resolve(null)), [me?.staff.role]);
  const homes = useLoad(() => (can('home.read') ? api<HomeView[]>('/homes') : Promise.resolve([])), [me?.staff.role]);
  const grants = useLoad(() => (can('grant.read') ? api<CloudGrantView[]>('/grants') : Promise.resolve([])), [me?.staff.role]);
  if (!me) return null;

  const open = (grants.data ?? []).filter((g) => g.status === 'pending' || g.status === 'active');
  const offline = (homes.data ?? []).filter((h) => h.hub && !h.hub.online);

  return (
    <Page eyebrow={`Signed in as ${ROLE_LABEL[me.staff.role]}`} title={`Hello, ${me.staff.displayName.split(' ')[0]}`}>
      <div className="stats">
        {can('home.read') && (
          <div className="stat">
            <b>{homes.data?.length ?? '–'}</b>
            <span>{me.staff.role === 'PLATFORM_SUPER_ADMIN' ? 'Homes' : 'Homes assigned to you'}</span>
          </div>
        )}
        {fleet.data && (
          <>
            <div className="stat">
              <b>
                {fleet.data.online}/{fleet.data.hubs}
              </b>
              <span>Hubs online</span>
            </div>
            <div className="stat">
              <b>{Object.keys(fleet.data.versions).length}</b>
              <span>Hub versions in the field</span>
            </div>
          </>
        )}
        {can('grant.read') && (
          <div className="stat">
            <b>{open.length}</b>
            <span>Support sessions open or waiting</span>
          </div>
        )}
      </div>

      <div className="cols">
        <div className="stack">
          {can('grant.read') && (
            <Card title="Support access" aside={<Link href="/grants/">All requests</Link>}>
              {open.length === 0 ? (
                <Empty>No open support sessions.</Empty>
              ) : (
                <div className="list">
                  {open.map((g) => (
                    <Link key={g.grantId} className="row" href={`/home/?id=${g.homeId}#grants`}>
                      <div className="row-main">
                        <p className="row-title">{g.reason}</p>
                        <p className="row-sub">
                          {g.staff.displayName} · until {dateTime(g.endsAt)}
                        </p>
                      </div>
                      <Badge status={g.status}>{g.status === 'pending' ? 'waiting for owner' : 'active'}</Badge>
                    </Link>
                  ))}
                </div>
              )}
            </Card>
          )}
          {can('home.read') && (
            <Card title="Hubs offline" aside={<Link href="/homes/">All homes</Link>}>
              {offline.length === 0 ? (
                <Empty>Every registered hub is reporting in.</Empty>
              ) : (
                <div className="list">
                  {offline.map((h) => (
                    <Link key={h.homeId} className="row" href={`/home/?id=${h.homeId}`}>
                      <span className="dot bad" aria-hidden="true" />
                      <div className="row-main">
                        <p className="row-title">{h.name}</p>
                        <p className="row-sub">
                          {h.hub!.hubId} · last seen {dateTime(h.hub!.lastSeenAt)}
                        </p>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </Card>
          )}
        </div>
        {fleet.data && (
          <Card title="Fleet" aside={<Link href="/fleet/">Rollouts</Link>}>
            <p className="small muted" style={{ marginTop: 0 }}>
              {fleet.data.activeRollout ? (
                <>
                  A rollout is running. <Link href={`/rollout/?id=${fleet.data.activeRollout}`}>Open it</Link>
                </>
              ) : (
                'No rollout running.'
              )}
            </p>
            <div className="list">
              {Object.entries(fleet.data.versions)
                .sort((a, b) => b[1] - a[1])
                .map(([v, n]) => (
                  <div className="row" key={v}>
                    <div className="row-main">
                      <p className="row-title">{v === 'unknown' ? 'Version not reported' : `Version ${v}`}</p>
                    </div>
                    <span className="small muted">
                      {n} {n === 1 ? 'hub' : 'hubs'}
                    </span>
                  </div>
                ))}
              {Object.keys(fleet.data.versions).length === 0 && <Empty>No hubs registered yet.</Empty>}
            </div>
          </Card>
        )}
      </div>
    </Page>
  );
}
