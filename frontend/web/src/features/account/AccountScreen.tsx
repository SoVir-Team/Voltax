'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, COOKIE_SESSION, apiRequest } from '@/lib/api';
import type { Role } from '@/lib/types';
import { useHub } from '@/providers/HubProvider';

// Signed-out screens (docs/customer-account-flow.md). Device controls only appear after sign-in:
// a homeowner code or an emailed invitation only opens account setup.
//   sign in · homeowner code -> welcome (create account) -> sign in
//   email invitation link -> accept -> create account (or sign in to accept) -> sign in
//   forgot password -> emailed 6-digit code -> new password -> sign in

type Mode = 'signin' | 'code' | 'invite' | 'signup' | 'forgot' | 'reset';
interface Setup {
  email: string;
  role: Role;
}

const MIN_PASSWORD = 12;

function message(err: unknown): string {
  if (err instanceof ApiError && err.status === 429) return 'Too many attempts. Please wait a few minutes and try again.';
  return err instanceof Error ? err.message : String(err);
}

/** Takes an invitation secret from the address (#invite=…) and removes it, so it is not kept in history. */
function readInvite(): string | null {
  const match = location.hash.match(/^#invite=([^&]+)/);
  if (!match) return null;
  history.replaceState(null, '', location.pathname + location.search);
  return decodeURIComponent(match[1]!);
}

export function AccountScreen() {
  const { hub, signIn } = useHub();
  const [mode, setMode] = useState<Mode>('signin');
  const [invite, setInvite] = useState<string | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [acceptInvitation, setAcceptInvitation] = useState(false);
  const [email, setEmail] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const secret = readInvite();
    if (secret) {
      setInvite(secret);
      setMode('invite');
    }
  }, []);

  const go = (next: Mode, note: string | null = null) => {
    setMode(next);
    setNotice(note);
    setError(null);
  };

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  /** Owner code or invitation secret -> a short-lived setup session (cookie) for creating the account. */
  const claim = (code: string) =>
    run(async () => {
      const { data } = await apiRequest<Setup>('/customer/claim', { method: 'POST', body: { code: code.trim() } });
      setSetup(data);
      setEmail(data.email);
      setAcceptInvitation(false);
      go('signup');
    });

  const titles: Record<Mode, string> = {
    signin: acceptInvitation ? 'Sign in to accept' : 'Sign in to your home',
    code: 'Set up your home',
    invite: 'You’re invited to a VOLTEX home',
    signup: setup?.role === 'member' ? 'Create your account' : 'Welcome to your VOLTEX home',
    forgot: 'Forgot your password?',
    reset: 'Choose a new password',
  };

  return (
    <div className="pair">
      <div className="card pair-card">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="for-light" src="/brand/logo.svg" alt="VOLTEX" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="for-dark" src="/brand/logo-dark.svg" alt="VOLTEX" />
        <h1 className="title">{titles[mode]}</h1>
        {hub && <p className="small muted">{hub.name}</p>}
        {notice && (
          <p className="form-ok" role="status">
            {notice}
          </p>
        )}

        {mode === 'signin' && (
          <SignIn
            email={email}
            setEmail={setEmail}
            busy={busy}
            onSubmit={(password) =>
              run(async () => {
                const { data } = await apiRequest<{ clientId: string; role: Role }>('/customer/login', {
                  method: 'POST',
                  body: { email, password, ...(acceptInvitation ? { acceptInvitation: true } : {}) },
                });
                signIn({ token: COOKIE_SESSION, role: data.role, clientId: data.clientId });
              })
            }
          >
            {error && <FormError text={error} />}
            <div className="form-links">
              <button type="button" className="link" onClick={() => go('forgot')}>
                Forgot password?
              </button>
              {!acceptInvitation && (
                <button type="button" className="link" onClick={() => go('code')}>
                  New homeowner? Enter your code
                </button>
              )}
            </div>
          </SignIn>
        )}

        {mode === 'code' && (
          <CodeForm busy={busy} onSubmit={(code) => void claim(code)}>
            {error && <FormError text={error} />}
            <div className="form-links">
              <button type="button" className="link" onClick={() => go('signin')}>
                Back to sign in
              </button>
            </div>
          </CodeForm>
        )}

        {mode === 'invite' && invite && (
          <div className="form">
            <p className="muted">Accept the invitation to create your account. You will get the controls the homeowner chose for you.</p>
            {error && <FormError text={error} />}
            <button className="btn block" type="button" disabled={busy} onClick={() => void claim(invite)}>
              Accept invitation
            </button>
            <div className="form-links">
              <button type="button" className="link" onClick={() => go('signin')}>
                Not now
              </button>
            </div>
          </div>
        )}

        {mode === 'signup' && setup && (
          <SignUp
            setup={setup}
            busy={busy}
            onSubmit={(name, password) =>
              run(async () => {
                await apiRequest('/customer/signup', { method: 'POST', body: { email: setup.email, name, password } });
                setSetup(null);
                go('signin', 'Your account is ready. Sign in to start using your home.');
              })
            }
          >
            {error && <FormError text={error} />}
            {setup.role === 'member' && (
              <div className="form-links">
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    setAcceptInvitation(true);
                    go('signin');
                  }}
                >
                  Already have a VOLTEX account? Sign in to accept
                </button>
              </div>
            )}
          </SignUp>
        )}

        {mode === 'forgot' && (
          <Forgot
            email={email}
            setEmail={setEmail}
            busy={busy}
            onSubmit={() =>
              run(async () => {
                const { data } = await apiRequest<{ message: string }>('/customer/forgot', { method: 'POST', body: { email } });
                go('reset', data.message);
              })
            }
          >
            {error && <FormError text={error} />}
            <div className="form-links">
              <button type="button" className="link" onClick={() => go('signin')}>
                Back to sign in
              </button>
            </div>
          </Forgot>
        )}

        {mode === 'reset' && (
          <Reset
            email={email}
            busy={busy}
            onSubmit={(code, password) =>
              run(async () => {
                await apiRequest('/customer/reset', { method: 'POST', body: { email, code, password } });
                go('signin', 'Password changed. Sign in with your new password.');
              })
            }
          >
            {error && <FormError text={error} />}
            <div className="form-links">
              <button type="button" className="link" onClick={() => go('forgot')}>
                Send a new code
              </button>
              <button type="button" className="link" onClick={() => go('signin')}>
                Back to sign in
              </button>
            </div>
          </Reset>
        )}
      </div>
    </div>
  );
}

function FormError({ text }: { text: string }) {
  return (
    <p className="form-error" role="alert">
      {text}
    </p>
  );
}

function submitWith(handler: () => void) {
  return (e: FormEvent) => {
    e.preventDefault();
    handler();
  };
}

function SignIn({ email, setEmail, busy, onSubmit, children }: { email: string; setEmail(v: string): void; busy: boolean; onSubmit(password: string): void; children: ReactNode }) {
  const [password, setPassword] = useState('');
  return (
    <form className="form" onSubmit={submitWith(() => onSubmit(password))}>
      <label className="field">
        Email
        <input type="email" autoComplete="username" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="field">
        Password
        <input type="password" autoComplete="current-password" required maxLength={256} value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <button className="btn block" type="submit" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      {children}
    </form>
  );
}

function CodeForm({ busy, onSubmit, children }: { busy: boolean; onSubmit(code: string): void; children: ReactNode }) {
  const [code, setCode] = useState('');
  return (
    <form className="form" onSubmit={submitWith(() => onSubmit(code))}>
      <p className="muted">Enter the one-time code you received from VOLTEX. It works once and expires after 10 minutes.</p>
      <label className="field">
        Homeowner code
        <input className="code-input" autoComplete="one-time-code" maxLength={11} placeholder="XXXXX-XXXXX" required value={code} onChange={(e) => setCode(e.target.value)} />
      </label>
      <button className="btn block" type="submit" disabled={busy}>
        {busy ? 'Checking…' : 'Continue'}
      </button>
      {children}
    </form>
  );
}

function NewPassword({ password, setPassword, confirm, setConfirm, label = 'Password' }: { password: string; setPassword(v: string): void; confirm: string; setConfirm(v: string): void; label?: string }) {
  return (
    <>
      <label className="field">
        {label}
        <input type="password" autoComplete="new-password" required minLength={MIN_PASSWORD} maxLength={256} value={password} onChange={(e) => setPassword(e.target.value)} />
        <span className="hint">At least {MIN_PASSWORD} characters.</span>
      </label>
      <label className="field">
        Confirm password
        <input type="password" autoComplete="new-password" required maxLength={256} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </label>
    </>
  );
}

function SignUp({ setup, busy, onSubmit, children }: { setup: Setup; busy: boolean; onSubmit(name: string, password: string): void; children: ReactNode }) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const mismatch = confirm.length > 0 && confirm !== password;
  return (
    <form className="form" onSubmit={submitWith(() => !mismatch && onSubmit(name, password))}>
      <p className="muted">
        {setup.role === 'owner'
          ? 'Create your account to start using your home. Your controls unlock after you sign in.'
          : 'Create your account, then sign in to use the controls the homeowner shared with you.'}
      </p>
      <label className="field">
        Email
        <input type="email" autoComplete="username" value={setup.email} readOnly />
      </label>
      <label className="field">
        Your name
        <input autoComplete="name" required maxLength={64} placeholder="e.g. Priya" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <NewPassword password={password} setPassword={setPassword} confirm={confirm} setConfirm={setConfirm} />
      {mismatch && <FormError text="The passwords do not match." />}
      <button className="btn block" type="submit" disabled={busy || mismatch}>
        {busy ? 'Creating account…' : 'Create account'}
      </button>
      {children}
    </form>
  );
}

function Forgot({ email, setEmail, busy, onSubmit, children }: { email: string; setEmail(v: string): void; busy: boolean; onSubmit(): void; children: ReactNode }) {
  return (
    <form className="form" onSubmit={submitWith(onSubmit)}>
      <p className="muted">Enter your account email. We will send you a 6-digit code to choose a new password.</p>
      <label className="field">
        Email
        <input type="email" autoComplete="username" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <button className="btn block" type="submit" disabled={busy}>
        {busy ? 'Sending…' : 'Send code'}
      </button>
      {children}
    </form>
  );
}

function Reset({ email, busy, onSubmit, children }: { email: string; busy: boolean; onSubmit(code: string, password: string): void; children: ReactNode }) {
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const mismatch = confirm.length > 0 && confirm !== password;
  return (
    <form className="form" onSubmit={submitWith(() => !mismatch && onSubmit(code, password))}>
      <p className="muted small">Code sent to {email}. It expires in 10 minutes.</p>
      <label className="field">
        6-digit code
        <input className="code-input" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
      </label>
      <NewPassword label="New password" password={password} setPassword={setPassword} confirm={confirm} setConfirm={setConfirm} />
      {mismatch && <FormError text="The passwords do not match." />}
      <button className="btn block" type="submit" disabled={busy || mismatch}>
        {busy ? 'Saving…' : 'Change password'}
      </button>
      {children}
    </form>
  );
}
