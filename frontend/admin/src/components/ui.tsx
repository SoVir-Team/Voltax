'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { tone } from '@/lib/format';
import { Icon } from './Icon';
import { useToast } from './Toast';

export function Page({
  eyebrow,
  title,
  back,
  actions,
  children,
}: {
  eyebrow?: string;
  title: string;
  back?: { href: string; label: string };
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="page">
      {back && (
        <Link className="back" href={back.href}>
          <Icon name="back" /> {back.label}
        </Link>
      )}
      <header className="page-head">
        <div>
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h1 className="title">{title}</h1>
        </div>
        {actions && <div className="page-actions">{actions}</div>}
      </header>
      {children}
    </div>
  );
}

export function Card({ title, aside, children, className = '' }: { title?: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || aside) && (
        <div className="card-head">
          {title && <h2>{title}</h2>}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

export const Badge = ({ status, children }: { status: string; children?: ReactNode }) => <span className={`badge ${tone(status)}`}>{children ?? status.replace(/_/g, ' ')}</span>;

export const Empty = ({ children }: { children: ReactNode }) => <p className="empty">{children}</p>;

export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="facts">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Loads data on mount and on reload(); API errors show inline (and as a toast). */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const toast = useToast();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const reload = useCallback(async () => {
    try {
      setData(await loadRef.current());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
      toast((err as Error).message, 'error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast, ...deps]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, reload, setData };
}

/** Runs an action with a busy flag; errors become a toast. Resolves true on success. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (fn: () => Promise<unknown>, done?: string) => {
      setBusy(true);
      try {
        await fn();
        if (done) toast(done);
        return true;
      } catch (err) {
        toast((err as Error).message, 'error');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return { busy, run };
}

export function Table({ head, rows, empty }: { head: string[]; rows: ReactNode[]; empty?: string }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows
          ) : (
            <tr>
              <td colSpan={head.length} className="empty">
                {empty ?? 'Nothing here yet.'}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A button that asks for a written reason inline before acting (halt, cancel, revoke, withdraw...).
 * Reasons go into the audit log.
 */
export function ReasonAction({
  label,
  confirmLabel,
  danger,
  minLength = 3,
  onSubmit,
}: {
  label: string;
  confirmLabel?: string;
  danger?: boolean;
  minLength?: number;
  onSubmit(reason: string): Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  if (!open)
    return (
      <button className={`btn sm ${danger ? 'danger' : 'ghost'}`} onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const ok = await onSubmit(reason.trim());
    setBusy(false);
    if (ok) {
      setOpen(false);
      setReason('');
    }
  }
  return (
    <form className="reason" onSubmit={(e) => void submit(e)}>
      <input autoFocus aria-label={`Reason: ${label}`} placeholder="Reason (kept in the audit log)" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      <button className={`btn sm ${danger ? 'danger' : ''}`} disabled={busy || reason.trim().length < minLength}>
        {confirmLabel ?? label}
      </button>
      <button type="button" className="btn sm ghost" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  );
}

/** A one-time secret (setup link, broker password): shown once, with copy. */
export function SecretBox({ title, value, note }: { title: string; value: string; note: string }) {
  const toast = useToast();
  return (
    <div className="secret" role="status">
      <p className="secret-title">{title}</p>
      <code>{value}</code>
      <div className="row-actions flat">
        <button
          className="btn sm secondary"
          onClick={() =>
            void navigator.clipboard?.writeText(value).then(
              () => toast('Copied'),
              () => toast('Copy failed: select the text instead', 'error'),
            )
          }
        >
          Copy
        </button>
      </div>
      <p className="small muted">{note}</p>
    </div>
  );
}
