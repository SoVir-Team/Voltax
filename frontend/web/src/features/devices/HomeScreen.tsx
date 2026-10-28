'use client';

import Link from 'next/link';
import { Icon } from '@/components/Icon';
import { InstallCard } from '@/components/InstallCard';
import { roomName } from '@/lib/format';
import { useEntities, useHub } from '@/providers/HubProvider';
import { DeviceTile } from './DeviceTile';

function greeting(hour: number) {
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}

/** Summary card and every device, grouped by room. */
export function HomeScreen() {
  const { devices, health } = useHub();
  const entities = useEntities();
  const switches = entities.filter((e) => e.component === 'switch');
  const online = devices.filter((d) => d.online).length;
  const onCount = switches.filter((e) => e.state === true).length;

  return (
    <div>
      <p className="eyebrow">{greeting(new Date().getHours())}</p>
      <h1 className="title">Your home, under control</h1>

      <div className="card hero">
        <div className="hero-row">
          <div>
            <div className="stat">
              {onCount}/{switches.length}
            </div>
            <div className="label">Switches on</div>
          </div>
          <div>
            <div className="stat">
              {online}/{devices.length}
            </div>
            <div className="label">Devices online</div>
          </div>
        </div>
        <div className="chips">
          <span className="chip">Works without internet</span>
          {health && !health.timeSynced && <span className="chip warn">Hub clock not synced: schedules may run at the wrong time</span>}
          {health && health.mqtt !== 'up' && <span className="chip warn">Device network reconnecting</span>}
        </div>
      </div>

      <InstallCard />

      {entities.length ? (
        devices
          .filter((d) => d.entities.length)
          .map((d) => (
            <section key={d.deviceId}>
              <div className="section-title">
                <h2>{roomName(d)}</h2>
                <span>{d.online ? `${d.entities.length} ${d.entities.length === 1 ? 'device' : 'devices'}` : 'Offline'}</span>
              </div>
              <div className="grid">
                {d.entities.map((e) => (
                  <DeviceTile key={e.entityId} entity={{ ...e, device: d }} />
                ))}
              </div>
            </section>
          ))
      ) : (
        <>
          <div className="section-title">
            <h2>Devices</h2>
          </div>
          <div className="card empty">
            <Icon name="plus" />
            <p>No devices yet.</p>
            <Link href="/hub/">How to add a device</Link>
          </div>
        </>
      )}
    </div>
  );
}
