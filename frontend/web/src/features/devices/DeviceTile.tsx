'use client';

import { useRouter } from 'next/navigation';
import { Icon } from '@/components/Icon';
import { pretty } from '@/lib/format';
import { useHub, type EntityWithDevice } from '@/providers/HubProvider';
import { PowerSwitch } from './PowerSwitch';

export const deviceHref = (entityId: string) => `/device/?id=${encodeURIComponent(entityId)}`;

export function stateLabel(entity: EntityWithDevice): string {
  const on = entity.state === true;
  if (entity.state === null) return 'No report yet';
  return entity.component === 'switch' ? (on ? 'On' : 'Off') : on ? 'Active' : 'Idle';
}

export function DeviceTile({ entity }: { entity: EntityWithDevice }) {
  const router = useRouter();
  const { pending } = useHub();
  const isSwitch = entity.component === 'switch';
  const on = entity.state === true;
  const open = () => router.push(deviceHref(entity.entityId));

  return (
    <div
      className={`card tile${on ? ' on' : ''}`}
      tabIndex={0}
      role="link"
      data-entity={entity.entityId}
      onClick={open}
      onKeyDown={(e) => e.key === 'Enter' && open()}
    >
      <div className="tile-head">
        <span className="tile-icon">
          <Icon name={isSwitch ? 'bulb' : 'sensor'} />
        </span>
        {isSwitch && <PowerSwitch entity={entity} />}
      </div>
      <div>
        <p className="tile-name">{pretty(entity.name)}</p>
        <p className="row-sub">{isSwitch ? 'Switch' : 'Sensor'}</p>
      </div>
      <div className="tile-meta">
        <span className={`dot ${entity.device.online ? 'ok' : 'bad'}`} />
        {!entity.device.online ? 'Offline' : pending.has(entity.entityId) ? 'Waiting for device…' : stateLabel(entity)}
      </div>
    </div>
  );
}
