'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { EntitySelect } from '@/components/EntitySelect';
import { Icon, strokeIcon } from '@/components/Icon';
import { TimePicker12 } from '@/components/TimePicker12';
import { cronLabel, dailyCron, pretty, type Time12 } from '@/lib/format';
import type { Schedule } from '@/lib/types';
import { useEntities, useHub } from '@/providers/HubProvider';
import { useToast } from '@/providers/ToastProvider';

/** Schedules (all, or one device's) plus the owner's "add schedule" form. */
export function ScheduleList({ entityId }: { entityId?: string }) {
  const { api, isOwner } = useHub();
  const toast = useToast();
  const entities = useEntities();
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);

  const load = useCallback(() => {
    api<Schedule[]>('/schedules').then(
      ({ data }) => setSchedules(data.filter((s) => !entityId || s.entityId === entityId)),
      (err: Error) => toast(err.message, 'error'),
    );
  }, [api, entityId, toast]);

  useEffect(load, [load]);

  async function remove(s: Schedule) {
    try {
      await api(`/schedules/${s.scheduleId}`, { method: 'DELETE' });
      toast('Schedule deleted');
      load();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }

  if (!schedules) return null;
  const nameOf = (id: string) => pretty(entities.find((e) => e.entityId === id)?.name ?? id);

  return (
    <>
      {schedules.length ? (
        <div className="list">
          {schedules.map((s) => (
            <div className="row" key={s.scheduleId}>
              <span className="avatar">
                <Icon name="clock" {...strokeIcon} />
              </span>
              <div className="row-main">
                <p className="row-title">{s.name}</p>
                <p className="row-sub">
                  {cronLabel(s.cron)} · turn {s.value ? 'on' : 'off'} · {nameOf(s.entityId)}
                </p>
              </div>
              <span className={`badge${s.enabled ? '' : ' grey'}`}>{s.enabled ? 'On' : 'Paused'}</span>
              {isOwner && (
                <button className="icon-btn" aria-label={`Delete ${s.name}`} onClick={() => void remove(s)}>
                  <Icon name="trash" />
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="muted small">No schedules yet.</p>
      )}
      {isOwner ? <ScheduleForm entityId={entityId} onSaved={load} /> : <p className="small muted">Only an owner can change schedules.</p>}
    </>
  );
}

function ScheduleForm({ entityId, onSaved }: { entityId?: string; onSaved(): void }) {
  const { api } = useHub();
  const toast = useToast();
  const firstSwitch = useEntities().find((e) => e.component === 'switch')?.entityId ?? '';
  const [name, setName] = useState('');
  const [time, setTime] = useState<Time12>({ hour: 7, minute: 0, period: 'PM' });
  const [value, setValue] = useState(true);
  const [target, setTarget] = useState(entityId ?? firstSwitch);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api('/schedules', { method: 'POST', body: { name, cron: dailyCron(time), entityId: entityId ?? (target || firstSwitch), value } });
      toast('Schedule saved on the hub');
      setName('');
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }

  return (
    <form className="form" style={{ marginTop: 14 }} onSubmit={submit}>
      <label className="field">
        Name
        <input placeholder="Evening lights" required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="field">
        <span>Time</span>
        <TimePicker12 value={time} onChange={setTime} />
      </div>
      <label className="field">
        Action
        <select value={String(value)} onChange={(e) => setValue(e.target.value === 'true')}>
          <option value="true">Turn on</option>
          <option value="false">Turn off</option>
        </select>
      </label>
      {!entityId && (
        <label className="field">
          Device
          <EntitySelect switchesOnly value={target || firstSwitch} onChange={setTarget} />
        </label>
      )}
      <button className="btn" type="submit">
        <Icon name="plus" {...strokeIcon} strokeWidth={2.4} />
        <span>Add schedule</span>
      </button>
    </form>
  );
}
