'use client';

import type { CloudGrantView, HomeView } from '@voltax/contracts';
import Link from 'next/link';
import { useState } from 'react';
import { GrantStatus } from '@/components/Grants';
import { Card, Page, Table, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime, GRANT_ACTION_LABEL } from '@/lib/format';

const FILTERS = [
  ['', 'All'],
  ['pending', 'Waiting'],
  ['active', 'Active'],
  ['revoked', 'Revoked'],
  ['expired', 'Expired'],
  ['completed', 'Completed'],
  ['rejected', 'Rejected'],
] as const;

/** Every support request this person may see: all of them for admins, assigned homes for others. */
export default function GrantsPage() {
  const [status, setStatus] = useState<string>('');
  const grants = useLoad(() => api<CloudGrantView[]>(`/grants${status ? `?status=${status}` : ''}`), [status]);
  const homes = useLoad(() => api<HomeView[]>('/homes'));
  const name = new Map((homes.data ?? []).map((h) => [h.homeId, h.name]));

  return (
    <Page eyebrow="Owner-approved, time-limited, recorded" title="Support access">
      <div className="segmented" role="radiogroup" aria-label="Status" style={{ marginBottom: 14 }}>
        {FILTERS.map(([value, label]) => (
          <button key={value} role="radio" aria-checked={status === value} className={status === value ? 'on' : ''} onClick={() => setStatus(value)}>
            {label}
          </button>
        ))}
      </div>
      <Card>
        <Table
          head={['Home', 'Reason', 'Requested by', 'Allowed', 'Window', 'Status']}
          empty={grants.data ? 'No requests.' : 'Loading…'}
          rows={(grants.data ?? []).map((g) => (
            <tr key={g.grantId}>
              <td>
                <Link href={`/home/?id=${g.homeId}#grants`}>{name.get(g.homeId) ?? 'Open home'}</Link>
              </td>
              <td>{g.reason}</td>
              <td>{g.staff.displayName}</td>
              <td className="small">{g.actions.map((a) => GRANT_ACTION_LABEL[a] ?? a).join(', ')}</td>
              <td className="small">
                {dateTime(g.startsAt)} – {dateTime(g.endsAt)}
              </td>
              <td>
                <GrantStatus g={g} />
              </td>
            </tr>
          ))}
        />
      </Card>
    </Page>
  );
}
