'use client';

import { useState, type FormEvent } from 'react';
import { ApiError, apiRequest } from '@/lib/api';
import type { PairResult } from '@/lib/types';
import { useHub } from '@/providers/HubProvider';
import { useToast } from '@/providers/ToastProvider';

/** First screen on a new browser: exchange a one-time pairing code for a hub token. */
export function PairScreen() {
  const { hub, signIn } = useHub();
  const toast = useToast();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const { data } = await apiRequest<PairResult>('/pair', { method: 'POST', body: { pairingCode: code, clientName: name } });
      toast('Connected to your VOLTEX hub');
      signIn(data);
    } catch (err) {
      toast(err instanceof ApiError && err.status === 429 ? 'Too many attempts. Wait 15 minutes and try again.' : 'That code is invalid or has expired.', 'error');
      setBusy(false);
    }
  }

  return (
    <div className="pair">
      <div className="card pair-card">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="for-light" src="/brand/logo.svg" alt="VOLTEX" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="for-dark" src="/brand/logo-dark.svg" alt="VOLTEX" />
        <h1 className="title">Connect to your home</h1>
        <p className="muted">Enter the one-time code from your installer or from the owner’s app. Codes expire after a few minutes and work once.</p>
        {hub && (
          <p className="small muted">
            Hub {hub.name} · {hub.hubId}
          </p>
        )}
        <form className="form" onSubmit={submit}>
          <label className="field">
            Pairing code
            <input
              className="code-input"
              autoComplete="one-time-code"
              maxLength={11}
              placeholder="XXXXX-XXXXX"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <label className="field">
            Name this device
            <input maxLength={64} placeholder="e.g. Priya’s iPhone" required value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <button className="btn block" type="submit" disabled={busy}>
            Connect to hub
          </button>
        </form>
      </div>
    </div>
  );
}
