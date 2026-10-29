'use client';

import { useState, type FormEvent } from 'react';
import { useSession } from '@/components/Session';
import { api, ApiError } from '@/lib/api';

/** Staff sign in with their own email and password. */
export default function LoginPage() {
  const { reload } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server. Check your connection.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <form className="card auth-card form" onSubmit={(e) => void submit(e)}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="logo for-light" src="/brand/logo-wordmark.svg" alt="VOLTEX" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="logo for-dark" src="/brand/logo-wordmark-dark.svg" alt="VOLTEX" />
        <h1 className="title">Staff sign in</h1>
        <p className="sub">Company portal. Every action is recorded.</p>
        <label className="field">
          Work email
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          Password
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && (
          <p className="note" role="alert">
            {error}
          </p>
        )}
        <button className="btn block" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="small muted" style={{ textAlign: 'center', margin: 0 }}>
          New here? Open the setup link your administrator sent you.
        </p>
      </form>
    </div>
  );
}
