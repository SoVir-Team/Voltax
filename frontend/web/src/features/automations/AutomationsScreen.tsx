'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { EntitySelect } from '@/components/EntitySelect';
import { Icon, strokeIcon } from '@/components/Icon';
import { pretty } from '@/lib/format';
import type { Automation } from '@/lib/types';
import { useEntities, useHub } from '@/providers/HubProvider';
import { useToast } from '@/providers/ToastProvider';

/** "When X happens, do Y" rules, evaluated on the hub. */
export function AutomationsScreen() {
  const { api, isOwner } = useHub();
  const toast = useToast();
  const entities = useEntities();
  const [automations, setAutomations] = useState<Automation[] | null>(null);

  const load = useCallback(() => {
    api<Automation[]>('/automations').then(
      ({ data }) => setAutomations(data),
      (err: Error) => toast(err.message, 'error'),
    );
  }, [api, toast]);

  useEffect(load, [load]);

  async function remove(a: Automation) {
    try {
      await api(`/automations/${a.automationId}`, { method: 'DELETE' });
      toast('Automation deleted');
      load();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }

  const nameOf = (id: string) => pretty(entities.find((e) => e.entityId === id)?.name ?? id);

  return (
    <div>
      <p className="eyebrow">Smart rules on your hub</p>
      <h1 className="title">Automations</h1>
      <div className="card">
        {automations &&
          (automations.length ? (
            <div className="list">
              {automations.map((a) => (
                <div className="row" key={a.automationId}>
                  <span className="avatar">
                    <Icon name="bolt" {...strokeIcon} />
                  </span>
                  <div className="row-main">
                    <p className="row-title">{a.name}</p>
                    <p className="row-sub">
                      When {nameOf(a.trigger.entityId)} turns {a.trigger.to ? 'on' : 'off'} → turn {nameOf(a.action.entityId)} {a.action.value ? 'on' : 'off'}
                      {a.action.revertAfterSeconds ? ` for ${a.action.revertAfterSeconds}s` : ''}
                    </p>
                  </div>
                  <span className={`badge${a.enabled ? '' : ' grey'}`}>{a.enabled ? 'On' : 'Paused'}</span>
                  {isOwner && (
                    <button className="icon-btn" aria-label={`Delete ${a.name}`} onClick={() => void remove(a)}>
                      <Icon name="trash" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="muted small">No automations yet.</p>
          ))}
        {automations && (isOwner ? <AutomationForm onSaved={load} /> : <p className="small muted">Only an owner can change automations.</p>)}
      </div>
    </div>
  );
}

function AutomationForm({ onSaved }: { onSaved(): void }) {
  const { api } = useHub();
  const toast = useToast();
  const entities = useEntities();
  const [name, setName] = useState('');
  const [triggerChoice, setTrigger] = useState('');
  const [to, setTo] = useState(true);
  const [targetChoice, setTarget] = useState('');
  const [value, setValue] = useState(true);
  const [revert, setRevert] = useState('');
  // Default to the first option until the owner picks one (devices may load after this form).
  const trigger = triggerChoice || (entities[0]?.entityId ?? '');
  const target = targetChoice || (entities.find((e) => e.component === 'switch')?.entityId ?? '');

  async function submit(e: FormEvent) {
    e.preventDefault();
    const action = { entityId: target, value, ...(revert ? { revertAfterSeconds: Number(revert) } : {}) };
    try {
      await api('/automations', { method: 'POST', body: { name, trigger: { entityId: trigger, to }, action } });
      toast('Automation saved on the hub');
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
        <input placeholder="Button turns on hall light" required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="form-row">
        <label className="field">
          When
          <EntitySelect value={trigger} onChange={setTrigger} />
        </label>
        <label className="field">
          &nbsp;
          <select value={String(to)} onChange={(e) => setTo(e.target.value === 'true')}>
            <option value="true">turns on / is pressed</option>
            <option value="false">turns off / is released</option>
          </select>
        </label>
      </div>
      <div className="form-row">
        <label className="field">
          Then
          <EntitySelect switchesOnly value={target} onChange={setTarget} />
        </label>
        <label className="field">
          &nbsp;
          <select value={String(value)} onChange={(e) => setValue(e.target.value === 'true')}>
            <option value="true">Turn on</option>
            <option value="false">Turn off</option>
          </select>
        </label>
      </div>
      <label className="field">
        Switch back after (seconds)
        <input type="number" min={1} max={86400} placeholder="Optional, e.g. 60" value={revert} onChange={(e) => setRevert(e.target.value)} />
      </label>
      <button className="btn" type="submit">
        Add automation
      </button>
    </form>
  );
}
