'use client';

import { PASSWORD_MIN } from '@voltax/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import { useSession } from '@/components/Session';
import { api, ApiError } from '@/lib/api';
import { PasswordInput } from '@/components/PasswordInput';

/** Choose a password using a one-time staff setup link. */
export default function SetupPage() {
  const { ready } = useSession();
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    const t = new URLSearchParams(location.search).get('token');
    if (t) {
      setToken(t);
      // Keep the one-time token out of history and any later screenshots.
      history.replaceState(null, '', '/setup/');
    }
  }, []);

  if (!ready) return <div className="boot" />;
  return (
    <div className="auth">
      <div className="card auth-card">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="logo for-light" src="/brand/logo-wordmark.svg" alt="VOLTEX" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="logo for-dark" src="/brand/logo-wordmark-dark.svg" alt="VOLTEX" />
        <PasswordStep token={token} />
      </div>
    </div>
  );
}

function PasswordStep({ token }: { token: string | null }) {
  const { reload } = useSession();
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!token)
    return (
      <>
        <h1 className="title">Setup link needed</h1>
        <p className="sub">Open the full setup link from your administrator. Links work once and expire.</p>
      </>
    );

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== again) return setError('The passwords do not match.');
    setBusy(true);
    setError(null);
    try {
      await api('/auth/setup', { method: 'POST', body: { token, password } });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={(e) => void submit(e)}>
      <h1 className="title">Choose a password</h1>
      <p className="sub">At least {PASSWORD_MIN} characters. A passphrase of a few words works well.</p>
      <label className="field">
        New password
        <PasswordInput autoComplete="new-password" minLength={PASSWORD_MIN} required value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <label className="field">
        Same password again
        <PasswordInput autoComplete="new-password" minLength={PASSWORD_MIN} required value={again} onChange={(e) => setAgain(e.target.value)} />
      </label>
      {error && (
        <p className="note" role="alert">
          {error}
        </p>
      )}
      <button className="btn block" disabled={busy}>
        Continue
      </button>
    </form>
  );
}
