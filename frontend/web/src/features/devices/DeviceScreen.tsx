'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Icon, strokeIcon } from '@/components/Icon';
import { ScheduleList } from '@/features/schedules/ScheduleList';
import { pretty, roomName, since } from '@/lib/format';
import { useEntities, useHub } from '@/providers/HubProvider';
import { stateLabel } from './DeviceTile';
import { RenameForm } from './RenameForm';

function BackLink() {
  return (
    <Link className="back" href="/">
      <Icon name="chevron" {...strokeIcon} />
      <span>Home</span>
    </Link>
  );
}

/** One device: big state dial, on/off action, rename (owner) and its schedules. */
export function DeviceScreen() {
  const entityId = useSearchParams().get('id') ?? '';
  const { pending, isOwner, sendCommand } = useHub();
  const entity = useEntities().find((e) => e.entityId === entityId);

  if (!entity) {
    return (
      <div>
        <BackLink />
        <div className="card empty">This device is not on the hub.</div>
      </div>
    );
  }

  const isSwitch = entity.component === 'switch';
  const on = entity.state === true;
  const isPending = pending.has(entity.entityId);
  const online = entity.device.online;

  return (
    <div>
      <BackLink />
      <h1 className="title">{pretty(entity.name)}</h1>
      <div className="split">
        <div className="card" data-entity={entity.entityId}>
          <div className={`dial${on ? ' on' : ''}`}>
            <div>
              <div className="dial-state">{isPending ? '…' : entity.state === null ? '—' : stateLabel(entity)}</div>
              <div className="dial-sub">{online ? `Reported ${since(entity.updatedAt)}` : 'Device offline'}</div>
            </div>
          </div>
          {isSwitch && (
            <div className="big-toggle">
              <button className={`btn${on ? ' secondary' : ''}`} style={{ minWidth: 180 }} disabled={isPending || !online} onClick={() => void sendCommand(entity.entityId, !on)}>
                {!online ? 'Device offline' : isPending ? 'Waiting for device…' : on ? 'Turn off' : 'Turn on'}
              </button>
            </div>
          )}
          <p className="small muted" style={{ textAlign: 'center' }}>
            {roomName(entity.device)} · {online ? 'Online' : 'Offline'}
          </p>
          {isOwner && <RenameForm entity={entity} />}
        </div>

        {isSwitch && (
          <div className="card">
            <div className="section-title" style={{ marginTop: 0 }}>
              <h2>Schedule</h2>
              <span>Runs on the hub</span>
            </div>
            <ScheduleList entityId={entity.entityId} />
          </div>
        )}
      </div>
    </div>
  );
}
