'use client';

import { InstallCard } from '@/components/InstallCard';
import { formatUptime } from '@/lib/format';
import { useHub } from '@/providers/HubProvider';

/** Hub health, how devices are added, install and sign-out. */
export function HubScreen() {
  const { health, hub, session, signOut } = useHub();
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
        <div className="card">
          <h2 style={{ margin: '0 0 8px', fontSize: '1.1875rem' }}>Add a device</h2>
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
  );
}
