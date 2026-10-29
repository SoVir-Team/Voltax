'use client';

import { PASSWORD_MIN } from '@voltax/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import { useSession } from '@/components/Session';
import { useTheme, type ThemeChoice } from '@/components/Theme';
import { useToast } from '@/components/Toast';
import { Card, Facts, Page, useAction, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { ROLE_LABEL } from '@/lib/nav';
import { currentSubscription, pushSupported, subscribe } from '@/lib/push';

export default function SettingsPage() {
  const { me, signOut } = useSession();
  if (!me) return null;
  return (
    <Page eyebrow="Your account" title="Settings">
      <div className="cols">
        <div className="stack">
          <Card title="Account">
            <Facts
              rows={[
                ['Name', me.staff.displayName],
                ['Email', me.staff.email],
                ['Role', ROLE_LABEL[me.staff.role]],
                ['Session ends', dateTime(me.sessionExpiresAt)],
              ]}
            />
            <div className="row-actions flat">
              <button className="btn sm ghost" onClick={() => void signOut()}>
                Sign out
              </button>
            </div>
          </Card>
          <ChangePassword />
        </div>
        <div className="stack">
          <Notifications />
          <Appearance />
        </div>
      </div>
    </Page>
  );
}

function ChangePassword() {
  const { busy, run } = useAction();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await run(() => api('/auth/password', { method: 'POST', body: { current, next } }), 'Password changed. Other sessions were signed out.');
    if (ok) {
      setCurrent('');
      setNext('');
    }
  }
  return (
    <Card title="Change password">
      <form className="form" onSubmit={(e) => void submit(e)}>
        <label className="field">
          Current password
          <input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
        </label>
        <label className="field">
          New password <span className="hint">at least {PASSWORD_MIN} characters</span>
          <input type="password" autoComplete="new-password" minLength={PASSWORD_MIN} required value={next} onChange={(e) => setNext(e.target.value)} />
        </label>
        <button className="btn sm" disabled={busy}>
          Change password
        </button>
      </form>
    </Card>
  );
}

function Notifications() {
  const toast = useToast();
  const { busy, run } = useAction();
  const info = useLoad(() => api<{ enabled: boolean; publicKey: string | null; subscriptions: number }>('/push'));
  const [supported, setSupported] = useState(false);
  const [on, setOn] = useState(false);

  useEffect(() => {
    const s = pushSupported();
    setSupported(s);
    if (s) void currentSubscription().then((sub) => setOn(sub !== null));
  }, []);

  const enable = () =>
    run(async () => {
      const sub = await subscribe(info.data!.publicKey!);
      if (!sub) return toast('Notifications are blocked in this browser’s settings', 'error');
      await api('/push/subscriptions', { method: 'POST', body: sub });
      setOn(true);
      toast('Notifications on for this browser');
      void info.reload();
    });

  const disable = () =>
    run(async () => {
      const sub = await currentSubscription();
      if (sub) {
        await api('/push/unsubscribe', {
          method: 'POST',
          body: { endpoint: sub.endpoint },
        });
        await sub.unsubscribe();
      }
      setOn(false);
      void info.reload();
    });

  return (
    <Card title="Notifications">
      <p className="small muted" style={{ marginTop: 0 }}>
        When an owner approves or rejects your support request, and when a session you are part of ends.
      </p>
      {!info.data ? null : !info.data.enabled || !info.data.publicKey ? (
        <p className="small" style={{ margin: 0 }}>
          Browser notifications are not configured on this server yet.
        </p>
      ) : !supported ? (
        <p className="small" style={{ margin: 0 }}>
          This browser cannot receive notifications here. Use the portal over HTTPS; on iPhone, add it to the Home Screen first.
        </p>
      ) : (
        <>
          <button className={`btn sm${on ? ' ghost' : ''}`} disabled={busy} onClick={() => void (on ? disable() : enable())}>
            {on ? 'Turn off for this browser' : 'Turn on for this browser'}
          </button>
          <p className="small muted" style={{ marginBottom: 0 }}>
            {info.data.subscriptions} {info.data.subscriptions === 1 ? 'browser' : 'browsers'} signed up on your account.
          </p>
        </>
      )}
    </Card>
  );
}

function Appearance() {
  const { theme, setTheme } = useTheme();
  const options: [ThemeChoice, string][] = [
    ['system', 'Automatic'],
    ['light', 'Light'],
    ['dark', 'Dark'],
  ];
  return (
    <Card title="Appearance">
      <div className="segmented" role="radiogroup" aria-label="Theme">
        {options.map(([value, label]) => (
          <button key={value} role="radio" aria-checked={theme === value} className={theme === value ? 'on' : ''} onClick={() => setTheme(value)}>
            {label}
          </button>
        ))}
      </div>
    </Card>
  );
}
