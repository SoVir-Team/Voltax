'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { DevicePicker } from '@/components/DevicePicker';
import { SupportPanel } from '@/features/support/SupportPanel';
import { ApiError } from '@/lib/api';
import { roomOf } from '@/lib/format';
import type { ClientView, DeviceGrantInput } from '@/lib/types';
import { useHub } from '@/providers/HubProvider';
import { useToast } from '@/providers/ToastProvider';

/** People in this home (owner manages) and VOLTEX support access (everyone sees it). */
export function AccessScreen() {
  const { isOwner } = useHub();
  return (
    <div>
      <p className="eyebrow">Smarter living, managed together</p>
      <h1 className="title">Access</h1>
      {isOwner ? (
        <div className="split">
          <ClientList />
          <div className="card">
            <h2 className="card-title">Share control with family</h2>
            <p className="muted small">Members control the devices you choose. Only owners change schedules, automations, access and updates.</p>
            <Invite />
          </div>
        </div>
      ) : (
        <div className="card empty">
          <p>Only the home owner can invite or remove people.</p>
        </div>
      )}
      <SupportPanel />
    </div>
  );
}

function ClientList() {
  const { api, session, devices } = useHub();
  const toast = useToast();
  const [clients, setClients] = useState<ClientView[]>([]);
  const [editing, setEditing] = useState<{ clientId: string; devices: DeviceGrantInput } | null>(null);

  const load = useCallback(() => {
    api<ClientView[]>('/clients').then(
      ({ data }) => setClients(data),
      (err: Error) => toast(err.message, 'error'),
    );
  }, [api, toast]);

  useEffect(load, [load]);

  const fail = (err: unknown) => toast(err instanceof Error ? err.message : String(err), 'error');

  async function remove(c: ClientView) {
    if (!confirm(`Remove ${c.name}? They lose access to this home immediately.`)) return;
    try {
      await api(`/clients/${c.clientId}`, { method: 'DELETE' });
      toast(`${c.name} removed`);
      load();
    } catch (err) {
      toast(err instanceof ApiError && err.status === 409 ? 'You can’t remove the last owner.' : (err as Error).message, 'error');
    }
  }

  async function setRole(c: ClientView, role: 'owner' | 'member') {
    const text =
      role === 'owner'
        ? `Make ${c.name} an owner? Owners can change everything, including access and updates.`
        : `Make ${c.name} a member? They keep control of every device until you choose otherwise.`;
    if (!confirm(text)) return;
    try {
      await api(`/clients/${c.clientId}/role`, { method: 'PUT', body: { role } });
      toast(`${c.name} is now ${role === 'owner' ? 'an owner' : 'a member'}`);
      load();
    } catch (err) {
      toast(err instanceof ApiError && err.status === 409 ? 'The home must keep at least one owner.' : (err as Error).message, 'error');
    }
  }

  async function saveDevices() {
    if (!editing) return;
    try {
      await api(`/clients/${editing.clientId}/devices`, { method: 'PUT', body: { devices: editing.devices } });
      toast('Devices updated');
      setEditing(null);
      load();
    } catch (err) {
      fail(err);
    }
  }

  const deviceSummary = (g: DeviceGrantInput | undefined) => {
    if (!g || g === '*') return 'All devices';
    if (g.length === 0) return 'No devices';
    const names = g.map((id) => devices.find((d) => d.deviceId === id)).map((d, i) => (d ? roomOf(d) : g[i]!));
    return names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ');
  };

  const active = clients.filter((c) => !c.revokedAt);
  const removed = clients.filter((c) => c.revokedAt);

  return (
    <div className="card">
      <div className="list">
        {active.map((c) => {
          const me = c.clientId === session?.clientId;
          return (
            <div key={c.clientId}>
              <div className="row">
                <span className="avatar">{c.name.trim().charAt(0).toUpperCase() || '?'}</span>
                <div className="row-main">
                  <p className="row-title">
                    {c.name} {me && <span className="small muted">(you)</span>}
                  </p>
                  <p className="row-sub">{c.role === 'owner' ? 'Owner · everything' : deviceSummary(c.devices)}</p>
                </div>
                <span className={`badge${c.role === 'owner' ? '' : ' grey'}`}>{c.role}</span>
              </div>
              <div className="row-actions">
                {c.role === 'member' && (
                  <button className="btn ghost sm" onClick={() => setEditing(editing?.clientId === c.clientId ? null : { clientId: c.clientId, devices: c.devices ?? '*' })}>
                    Devices
                  </button>
                )}
                <button className="btn ghost sm" onClick={() => void setRole(c, c.role === 'owner' ? 'member' : 'owner')}>
                  {c.role === 'owner' ? 'Make member' : 'Make owner'}
                </button>
                {!me && (
                  <button className="btn danger sm" onClick={() => void remove(c)}>
                    Remove
                  </button>
                )}
              </div>
              {editing?.clientId === c.clientId && (
                <div className="inline-editor">
                  <DevicePicker value={editing.devices} onChange={(devices) => setEditing({ ...editing, devices })} />
                  <div className="row-actions">
                    <button className="btn sm" onClick={() => void saveDevices()}>
                      Save
                    </button>
                    <button className="btn ghost sm" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {removed.length > 0 && <p className="small muted" style={{ margin: '10px 4px 0' }}>Removed: {removed.map((c) => c.name).join(', ')}</p>}
    </div>
  );
}

interface Invitation {
  invitationId: string;
  email: string;
  expiresAt: number;
}

/** The owner invites by email; the person accepts from the email, creates an account and signs in. */
function Invite() {
  const { api } = useHub();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [devices, setDevices] = useState<DeviceGrantInput>('*');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Invitation[]>([]);

  const load = useCallback(() => {
    api<Invitation[]>('/customer/invitations').then(
      ({ data }) => setPending(data),
      () => undefined,
    );
  }, [api]);
  useEffect(load, [load]);

  async function send(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/customer/invitations', { method: 'POST', body: { email, devices } });
      toast(`Invitation sent to ${email}`);
      setEmail('');
      load();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function cancel(i: Invitation) {
    try {
      await api(`/customer/invitations/${i.invitationId}`, { method: 'DELETE' });
      toast(`Invitation to ${i.email} cancelled`);
      load();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  return (
    <>
      <form className="form" onSubmit={(e) => void send(e)}>
        <label className="field">
          Family member’s email
          <input type="email" autoComplete="off" required maxLength={254} placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <DevicePicker value={devices} onChange={setDevices} />
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Sending…' : 'Invite'}
        </button>
      </form>
      <p className="small muted">They get an email with an Accept button, create their account, then sign in. The link works once and expires in 24 hours.</p>
      {pending.length > 0 && (
        <div className="list" style={{ marginTop: 10 }}>
          {pending.map((i) => (
            <div key={i.invitationId} className="row">
              <div className="row-main">
                <p className="row-title">{i.email}</p>
                <p className="row-sub">Invited · expires {new Date(i.expiresAt).toLocaleString()}</p>
              </div>
              <button className="btn ghost sm" onClick={() => void cancel(i)}>
                Cancel
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
