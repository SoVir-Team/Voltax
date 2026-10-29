'use client';

import { PASSWORD_MIN } from '@voltax/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import { useSession } from '@/components/Session';
import { api, ApiError } from '@/lib/api';

/**
 * First sign-in from a one-time setup link (/setup/?token=...): choose a password, then enrol an
 * authenticator app. The portal opens only after both; a password alone never gives access.
 */
export default function SetupPage() {
  const { me, ready } = useSession();
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
        <div className="steps" aria-hidden="true" style={{ marginTop: 16 }}>
          <i className="on" />
          <i className={me ? 'on' : ''} />
        </div>
        {me && !me.mfa ? <TotpStep /> : <PasswordStep token={token} />}
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
        <input type="password" autoComplete="new-password" minLength={PASSWORD_MIN} required value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <label className="field">
        Same password again
        <input type="password" autoComplete="new-password" minLength={PASSWORD_MIN} required value={again} onChange={(e) => setAgain(e.target.value)} />
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

function TotpStep() {
  const { reload, signOut } = useSession();
  const [enrol, setEnrol] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ secret: string; uri: string }>('/auth/totp/begin', {
      method: 'POST',
    }).then(setEnrol, (err: Error) => setError(err.message));
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/totp/confirm', { method: 'POST', body: { code } });
      await reload();
    } catch (err) {
      setError((err as Error).message);
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={(e) => void submit(e)}>
      <h1 className="title">Turn on two-factor</h1>
      <p className="sub">Add VOLTEX to an authenticator app (1Password, Google Authenticator, Microsoft Authenticator…), then type the code it shows.</p>
      {enrol && (
        <div className="secret">
          <p className="secret-title">Setup key</p>
          <code aria-label="Setup key">{enrol.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
          <p className="small muted" style={{ marginBottom: 0 }}>
            On this phone? <a href={enrol.uri}>Open in authenticator app</a>
          </p>
        </div>
      )}
      <label className="field">
        6-digit code
        <input
          className="code-input"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          required
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        />
      </label>
      {error && (
        <p className="note" role="alert">
          {error}
        </p>
      )}
      <button className="btn block" disabled={busy || !enrol}>
        Finish setup
      </button>
      <button type="button" className="btn ghost block" onClick={() => void signOut()}>
        Cancel
      </button>
    </form>
  );
}
