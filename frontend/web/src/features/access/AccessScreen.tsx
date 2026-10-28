'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { formatPairingCode } from '@/lib/format';
import type { Client, PairingCode } from '@/lib/types';
import { useHub } from '@/providers/HubProvider';
import { useToast } from '@/providers/ToastProvider';

/** Owner-only: see paired phones/browsers, invite members, remove access. */
export function AccessScreen() {
  const { isOwner } = useHub();
  if (!isOwner) {
    return (
      <div>
        <h1 className="title">User access</h1>
        <div className="card empty">
          <p>Only the home owner can invite or remove people.</p>
        </div>
      </div>
    );
  }
  return (
    <div>
      <p className="eyebrow">Smarter living, managed together</p>
      <h1 className="title">User access</h1>
      <div className="split">
        <ClientList />
        <div className="card">
          <h2 style={{ margin: '0 0 6px', fontSize: '1.1875rem' }}>Share control with family</h2>
          <p className="muted small">Members can control devices. Only owners can change schedules, automations and access.</p>
          <Invite />
        </div>
      </div>
    </div>
  );
}

function ClientList() {
  const { api, session } = useHub();
  const toast = useToast();
  const [clients, setClients] = useState<Client[]>([]);

  const load = useCallback(() => {
    api<Client[]>('/clients').then(
      ({ data }) => setClients(data),
      (err: Error) => toast(err.message, 'error'),
    );
  }, [api, toast]);

  useEffect(load, [load]);

  async function remove(c: Client) {
    if (!confirm(`Remove ${c.name}? Their app stops working on this hub immediately.`)) return;
    try {
      await api(`/clients/${c.clientId}`, { method: 'DELETE' });
      toast(`${c.name} removed`);
      load();
    } catch (err) {
      toast(err instanceof ApiError && err.status === 409 ? 'You can’t remove the last owner.' : String((err as Error).message), 'error');
    }
  }

  return (
    <div className="card">
      <div className="list">
        {clients.map((c) => (
          <div className="row" key={c.clientId}>
            <span className="avatar">{c.name.trim().charAt(0).toUpperCase() || '?'}</span>
            <div className="row-main">
              <p className="row-title">{c.name}</p>
              <p className="row-sub">Paired {new Date(c.createdAt).toLocaleDateString()}</p>
            </div>
            {c.revokedAt ? <span className="badge bad">Removed</span> : <span className={`badge${c.role === 'owner' ? '' : ' grey'}`}>{c.role}</span>}
            {c.clientId === session?.clientId ? (
              <span className="small muted">You</span>
            ) : (
              !c.revokedAt && (
                <button className="btn danger sm" onClick={() => void remove(c)}>
                  Remove
                </button>
              )
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Invite() {
  const { api } = useHub();
  const toast = useToast();
  const [invite, setInvite] = useState<PairingCode | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!invite) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [invite]);

  async function create() {
    try {
      const { data } = await api<PairingCode>('/pairing-codes', { method: 'POST' });
      setNow(Date.now());
      setInvite(data);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  const left = invite ? Math.max(0, Math.round((invite.expiresAt - now) / 1000)) : 0;

  return (
    <>
      <button className="btn" onClick={() => void create()}>
        Invite a member
      </button>
      {invite && (
        <div style={{ marginTop: 14 }}>
          <div className="code-box">
            <p className="muted small">Share this code with the person you are inviting</p>
            <div className="code">{formatPairingCode(invite.code)}</div>
            <p className="small muted">
              {left ? `Single use · expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'Expired. Create a new code.'}
            </p>
          </div>
        </div>
      )}
    </>
  );
}
