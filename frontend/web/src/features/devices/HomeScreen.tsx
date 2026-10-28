'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { InstallCard } from '@/components/InstallCard';
import { groupByRoom, matchesDevice, type DeviceFilter } from '@/lib/format';
import { useEntities, useHub } from '@/providers/HubProvider';
import { DeviceTile } from './DeviceTile';

function greeting(hour: number) {
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}

const FILTERS: [DeviceFilter, string][] = [
  ['all', 'All'],
  ['on', 'On'],
  ['off', 'Off'],
  ['offline', 'Offline'],
];

/** Summary card and every device, grouped by room, with search and filters. */
export function HomeScreen() {
  const { devices, health } = useHub();
  const entities = useEntities();
  const switches = entities.filter((e) => e.component === 'switch');
  const online = devices.filter((d) => d.online).length;
  const onCount = switches.filter((e) => e.state === true).length;
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<DeviceFilter>('all');
  const rooms = groupByRoom(entities.filter((e) => matchesDevice(e, query, filter)));

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
        <>
          <div className="finder">
            <label className="search">
              <span className="sr-only">Search devices and rooms</span>
              <input type="search" placeholder="Search devices or rooms" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            <div className="segmented" role="radiogroup" aria-label="Show">
              {FILTERS.map(([value, label]) => (
                <button key={value} role="radio" aria-checked={filter === value} className={filter === value ? 'on' : ''} onClick={() => setFilter(value)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          {rooms.length === 0 && <div className="card empty small">Nothing matches. Try another word or filter.</div>}
          {rooms.map(([room, list]) => {
            const offline = list.filter((e) => !e.device.online).length;
            return (
              <section key={room}>
                <div className="section-title">
                  <h2>{room}</h2>
                  <span>
                    {list.length} {list.length === 1 ? 'device' : 'devices'}
                    {offline ? ` · ${offline} offline` : ''}
                  </span>
                </div>
                <div className="grid">
                  {list.map((e) => (
                    <DeviceTile key={e.entityId} entity={e} />
                  ))}
                </div>
              </section>
            );
          })}
        </>
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
