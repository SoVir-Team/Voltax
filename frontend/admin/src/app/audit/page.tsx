'use client';

import type { AuditRecordView } from '@voltax/contracts';
import { useState } from 'react';
import { Badge, Card, Facts, Page, Table, useAction, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';

interface Checkpoint {
  id: number;
  at: number;
  lastSeq: number;
  headHash: string;
  keyId: string;
  signature: string;
}
// POST /audit/verify: the hash chain plus every signed checkpoint against the stored records.
interface VerifyResult {
  ok: boolean;
  chain: { ok: true; count: number; head: string } | { ok: false; brokenAt: number; reason: string };
  checkpoints: number;
  problems: string[];
}

const PAGE = 100;

/** The cloud audit chain: append-only, hash-linked, with signed checkpoints. Read-only here. */
export default function AuditPage() {
  const { busy, run } = useAction();
  const [after, setAfter] = useState(0);
  const [pages, setPages] = useState<number[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const records = useLoad(() => api<AuditRecordView[]>(`/audit?afterSeq=${after}&limit=${PAGE}`), [after]);
  const checkpoints = useLoad(() => api<Checkpoint[]>('/audit/checkpoints'));
  const rows = records.data ?? [];

  return (
    <Page
      eyebrow="Append-only and tamper-evident"
      title="Audit"
      actions={
        <button className="btn" disabled={busy} onClick={() => void run(async () => setResult(await api<VerifyResult>('/audit/verify', { method: 'POST' })))}>
          Verify the chain
        </button>
      }
    >
      {result && (
        <div className={`note ${result.ok ? 'info' : ''}`} role="status">
          <p style={{ margin: 0 }}>
            {result.chain.ok
              ? `Chain intact: ${result.chain.count} records, each linked to the one before (head ${result.chain.head.slice(0, 16)}…).`
              : `Chain broken at record #${result.chain.brokenAt}: ${result.chain.reason}.`}{' '}
            {result.checkpoints} signed {result.checkpoints === 1 ? 'checkpoint' : 'checkpoints'} checked.
          </p>
          {result.problems.length > 0 && (
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {result.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="stack">
        <Card
          title={`Records ${rows.length ? `#${rows[0]!.seq}–#${rows[rows.length - 1]!.seq}` : ''}`}
          aside={
            <div className="row-actions">
              <button className="btn sm ghost" disabled={!pages.length} onClick={() => (setAfter(pages[pages.length - 1]!), setPages(pages.slice(0, -1)))}>
                Earlier
              </button>
              <button className="btn sm ghost" disabled={rows.length < PAGE} onClick={() => (setPages([...pages, after]), setAfter(rows[rows.length - 1]!.seq))}>
                Later
              </button>
            </div>
          }
        >
          <Table
            head={['#', 'When', 'Actor', 'Action', 'Target', 'Outcome']}
            empty={records.data ? 'No records.' : 'Loading…'}
            rows={
              rows
                .flatMap((r) => [
                  <tr key={r.seq} onClick={() => setOpen(open === r.seq ? null : r.seq)} style={{ cursor: 'pointer' }} aria-expanded={open === r.seq}>
                    <td>{r.seq}</td>
                    <td className="small">{dateTime(r.at)}</td>
                    <td className="mono small">{r.actor}</td>
                    <td className="mono small">{r.action}</td>
                    <td className="mono small">{r.target ?? ''}</td>
                    <td>
                      <Badge status={r.outcome} />
                    </td>
                  </tr>,
                  open === r.seq && (
                    <tr key={`${r.seq}-d`}>
                      <td colSpan={6}>
                        <Facts
                          rows={[
                            ['Hash', <code key="h">{r.hash}</code>],
                            ['Previous', <code key="p">{r.prevHash}</code>],
                            ['Home', r.homeId ?? '—'],
                          ]}
                        />
                        <pre className="json" style={{ marginTop: 10 }}>
                          {JSON.stringify(r.details, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  ),
                ])
                .filter(Boolean) as React.ReactNode[]
            }
          />
        </Card>
        <Card title="Signed checkpoints">
          <p className="small muted" style={{ marginTop: 0 }}>
            The chain head, signed periodically. Copies kept off this server let anyone prove the log was not rewritten afterwards.
          </p>
          <Table
            head={['Up to', 'Signed', 'Key']}
            empty="No checkpoints yet."
            rows={(checkpoints.data ?? []).map((c) => (
              <tr key={c.id} title={c.headHash}>
                <td>#{c.lastSeq}</td>
                <td className="small">{dateTime(c.at)}</td>
                <td className="mono small">{c.keyId}</td>
              </tr>
            ))}
          />
        </Card>
      </div>
    </Page>
  );
}
