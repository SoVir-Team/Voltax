'use client';

import { pretty, roomOf } from '@/lib/format';
import { useEntities } from '@/providers/HubProvider';

/** <select> of entities, labelled "Room · Name". `switchesOnly` limits it to things that can be turned on/off. */
export function EntitySelect({ value, onChange, switchesOnly = false }: { value: string; onChange(entityId: string): void; switchesOnly?: boolean }) {
  const entities = useEntities().filter((e) => !switchesOnly || e.component === 'switch');
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {entities.map((e) => (
        <option key={e.entityId} value={e.entityId}>
          {roomOf(e.device)} · {pretty(e.name)}
        </option>
      ))}
    </select>
  );
}
