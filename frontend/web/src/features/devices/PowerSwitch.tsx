'use client';

import { useEffect, useRef, useState } from 'react';
import { pretty } from '@/lib/format';
import { useHub, type EntityWithDevice } from '@/providers/HubProvider';

/** iOS-style switch. Position = REPORTED state; pulses while a command waits; shakes if it fails. */
export function PowerSwitch({ entity }: { entity: EntityWithDevice }) {
  const { pending, failures, sendCommand } = useHub();
  const isPending = pending.has(entity.entityId);
  const failCount = failures[entity.entityId] ?? 0;
  const [shake, setShake] = useState(false);
  const seenFailures = useRef(failCount);

  useEffect(() => {
    if (failCount === seenFailures.current) return;
    seenFailures.current = failCount;
    setShake(true);
  }, [failCount]);

  return (
    <button
      type="button"
      role="switch"
      className={`switch${shake ? ' shake' : ''}`}
      aria-checked={entity.state === true}
      aria-label={`${pretty(entity.name)} power`}
      data-pending={isPending ? 'true' : undefined}
      disabled={!entity.device.online || isPending}
      onClick={(e) => {
        e.stopPropagation();
        void sendCommand(entity.entityId, entity.state !== true);
      }}
      onAnimationEnd={() => setShake(false)}
    />
  );
}
