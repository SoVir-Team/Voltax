'use client';

import { useCallback, useEffect, useState } from 'react';
import { InstallCard } from '@/components/InstallCard';
import { formatUptime } from '@/lib/format';
import { currentSubscription, pushSupport, subscribe, type PushSupport } from '@/lib/push';
import type { HubUpdatesView, UpdatePolicy } from '@/lib/types';
import { useHub } from '@/providers/HubProvider';
import { useTheme, type ThemeChoice } from '@/providers/ThemeProvider';
import { useToast } from '@/providers/ToastProvider';

/** Hub health, updates (owner), notifications, appearance, how devices are added, sign-out. */
export function HubScreen() {
  const { health, hub, session, signOut, isOwner } = useHub();
  const rows: [string, string][] = health
    ? [
        ['Hub', `${hub?.name ?? ''} · ${health.hubId}`],
        ['Software', health.version],
        ['Status', health.status === 'ok' ? 'All systems normal' : 'Degraded'],
        ['Database', health.db === 'up' ? 'Healthy' : 'Down'],
        ['Device network (MQTT)', health.mqtt === 'up' ? 'Connected' : 'Reconnecting'],
        ['Clock', health.timeSynced ? 'Synced' : 'Not synced (no internet since boot?)'],
        ['Uptime', formatUptime(health.uptime)],
        ['Your role', session?.role ?? ''],
      ]
    : [];

  return (
    <div>
      <p className="eyebrow">Your local home server</p>
      <h1 className="title">Hub</h1>
      <div className="split">
        <div className="stack">
          <div className="card">
            <div className="list">
              {rows.map(([k, v]) => (
                <div className="row" key={k}>
                  <div className="row-main">
                    <p className="row-sub" style={{ margin: 0 }}>
                      {k}
                    </p>
                    <p className="row-title">{v}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
          {isOwner && <UpdatesCard />}
        </div>
        <div className="stack">
          <NotificationsCard />
          <AppearanceCard />
          <div className="card">
            <h2 className="card-title">Add a device</h2>
            <p className="muted small">
              New VOLTEX switches are added by your installer. Each device gets its own secure credential on this hub, then appears here automatically once it reports in.
            </p>
            <ol className="small" style={{ paddingLeft: 18, color: 'var(--navy-2)' }}>
              <li>Installer runs add-device on the hub</li>
              <li>Installer flashes the switch with its credential</li>
              <li>The switch connects and shows up on Home</li>
            </ol>
            <InstallCard compact />
            <button
              className="btn ghost block"
              style={{ marginTop: 8 }}
              onClick={() => {
                if (confirm('Forget this hub on this browser?')) signOut();
              }}
            >
              Sign out of this browser
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const STATE_TEXT: Record<string, string> = {
  idle: 'Up to date',
  requested: 'Update requested: installing shortly',
  applying: 'Installing…',
  done: 'Last update installed',
  failed: 'Last update failed; the previous version is still running',
  rolled_back: 'Last update was rolled back automatically',
};

/** Owner: updates are only ever offered by VOLTEX; this hub installs one only with your OK (or your auto policy). */
function UpdatesCard() {
  const { api, onEvent } = useHub();
  const toast = useToast();
  const [view, setView] = useState<HubUpdatesView | null>(null);

  const load = useCallback(() => {
    api<HubUpdatesView>('/updates').then(
      ({ data }) => setView(data),
      () => {},
    );
  }, [api]);

  useEffect(() => {
    load();
    return onEvent((e) => {
      if (e.type.startsWith('update.')) load();
    });
  }, [load, onEvent]);

  async function decide(rolloutId: string, decision: 'approve' | 'decline') {
    try {
      const { data } = await api<HubUpdatesView>(`/updates/${rolloutId}/${decision}`, { method: 'POST' });
      setView(data);
      toast(decision === 'approve' ? 'Update approved. The hub installs it and restarts by itself.' : 'Update declined');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  async function setPolicy(policy: UpdatePolicy) {
    try {
      const { data } = await api<HubUpdatesView>('/updates/policy', { method: 'PUT', body: { policy } });
      setView(data);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  if (!view) return null;
  const waiting = view.offers.filter((o) => o.status === 'pending');

  return (
    <div className="card">
      <h2 className="card-title">Software updates</h2>
      <p className="small muted" style={{ marginTop: 0 }}>
        Version {view.currentVersion} · {STATE_TEXT[view.state.state] ?? view.state.state}
      </p>
      {waiting.map((o) => (
        <div className="offer" key={o.rolloutId}>
          <div className="row-main">
            <p className="row-title">Version {o.version} is available</p>
            <p className="row-sub">
              Offered by VOLTEX ({o.offeredBy}) · {new Date(o.offeredAt).toLocaleDateString()}. Signed by VOLTEX and checked again by the hub before it installs.
            </p>
          </div>
          <div className="row-actions">
            <button className="btn sm" onClick={() => void decide(o.rolloutId, 'approve')}>
              Install
            </button>
            <button className="btn ghost sm" onClick={() => void decide(o.rolloutId, 'decline')}>
              Not now
            </button>
          </div>
        </div>
      ))}
      <div className="segmented" role="radiogroup" aria-label="Update policy">
        {(
          [
            ['approve', 'Ask me first'],
            ['auto', 'Install automatically'],
          ] as const
        ).map(([value, label]) => (
          <button key={value} role="radio" aria-checked={view.policy === value} className={view.policy === value ? 'on' : ''} onClick={() => void setPolicy(value)}>
            {label}
          </button>
        ))}
      </div>
      <p className="small muted" style={{ marginBottom: 0 }}>
        {view.policy === 'auto' ? 'Signed VOLTEX updates install when offered. A failed update rolls back automatically.' : 'Nothing installs until you tap Install.'}
      </p>
    </div>
  );
}

const SUPPORT_TEXT: Record<Exclude<PushSupport, 'ok'>, string> = {
  insecure: 'Notifications need the app opened over HTTPS from your hub (your installer sets this up).',
  unsupported: 'This browser cannot show notifications from web apps.',
  'ios-not-installed': 'On iPhone, add VOLTEX to your Home Screen first (Share → Add to Home Screen), then turn notifications on there.',
};

function NotificationsCard() {
  const { api, isOwner } = useHub();
  const toast = useToast();
  const [support, setSupport] = useState<PushSupport>('unsupported');
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const s = pushSupport();
    setSupport(s);
    if (s === 'ok') void currentSubscription().then((sub) => setOn(sub !== null));
  }, []);

  async function enable() {
    setBusy(true);
    try {
      const { data } = await api<{ publicKey: string }>('/push/key');
      const sub = await subscribe(data.publicKey);
      if (!sub) return toast('Notifications are blocked in this browser’s settings', 'error');
      await api('/push/subscriptions', { method: 'POST', body: sub });
      setOn(true);
      toast('Notifications on for this device');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      const sub = await currentSubscription();
      if (sub) {
        await api('/push/subscriptions', { method: 'DELETE', body: { endpoint: sub.endpoint } });
        await sub.unsubscribe();
      }
      setOn(false);
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2 className="card-title">Notifications</h2>
      <p className="small muted" style={{ marginTop: 0 }}>
        {isOwner ? 'Support requests and sessions, offline devices and updates waiting for you.' : 'Support sessions and your devices going offline.'} Sent by your hub; needs internet.
      </p>
      {support === 'ok' ? (
        <button className={`btn${on ? ' ghost' : ''}`} disabled={busy} onClick={() => void (on ? disable() : enable())}>
          {on ? 'Turn off on this device' : 'Turn on for this device'}
        </button>
      ) : (
        <p className="small" style={{ margin: 0 }}>
          {SUPPORT_TEXT[support]}
        </p>
      )}
    </div>
  );
}

function AppearanceCard() {
  const { theme, setTheme } = useTheme();
  const options: [ThemeChoice, string][] = [
    ['system', 'Automatic'],
    ['light', 'Light'],
    ['dark', 'Dark'],
  ];
  return (
    <div className="card">
      <h2 className="card-title">Appearance</h2>
      <div className="segmented" role="radiogroup" aria-label="Theme">
        {options.map(([value, label]) => (
          <button key={value} role="radio" aria-checked={theme === value} className={theme === value ? 'on' : ''} onClick={() => setTheme(value)}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
