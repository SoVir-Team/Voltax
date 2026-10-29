'use client';

// Session + live connection to the hub. The UI always renders the state a DEVICE REPORTED,
// never the state it asked for: a command only clears its "pending" mark once the hub
// confirms the device reported the requested value (or the command fails/expires).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, COOKIE_SESSION, apiRequest, hubWebSocketUrl, type ApiOptions, type ApiResponse } from '@/lib/api';
import { pretty } from '@/lib/format';
import type { CommandView, DeviceView, EntityView, HealthView, HubEvent, HubIdentity, PairResult, Role, WsServerMessage } from '@/lib/types';
import { uuid } from '@/lib/uuid';
import { useToast } from './ToastProvider';

export type Connection = 'connecting' | 'live' | 'offline';
export type EntityWithDevice = EntityView & { device: DeviceView };

interface Session {
  token: string;
  role: Role;
  clientId: string | null;
}

interface HubContextValue {
  /** false until the saved session has been read from this browser */
  ready: boolean;
  session: Session | null;
  isOwner: boolean;
  hub: HubIdentity | null;
  health: HealthView | null;
  devices: DeviceView[];
  conn: Connection;
  /** entityIds with a command waiting for the device to confirm */
  pending: ReadonlySet<string>;
  /** bumps per entity when a command fails, so its switch can shake */
  failures: Readonly<Record<string, number>>;
  api<T>(path: string, options?: ApiOptions): Promise<ApiResponse<T>>;
  sendCommand(entityId: string, value: boolean): Promise<void>;
  refresh(): Promise<void>;
  /** Every live hub event (screens refetch what they show, e.g. support sessions). */
  onEvent(listener: (event: HubEvent) => void): () => void;
  signIn(result: PairResult): void;
  signOut(message?: string): void;
}

const STORAGE = { token: 'voltax.token', role: 'voltax.role', clientId: 'voltax.clientId' } as const;
const REVOKED = 'You were signed out. Sign in again to continue.';
const TERMINAL = new Set(['confirmed', 'failed', 'expired']);

const HubContext = createContext<HubContextValue | null>(null);

export function HubProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [hub, setHub] = useState<HubIdentity | null>(null);
  const [health, setHealth] = useState<HealthView | null>(null);
  const [devices, setDevices] = useState<DeviceView[]>([]);
  const [conn, setConn] = useState<Connection>('connecting');
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [failures, setFailures] = useState<Record<string, number>>({});

  // Read by WebSocket/command callbacks without re-subscribing.
  const tokenRef = useRef<string | null>(null);
  const pendingRef = useRef(new Map<string, string>()); // entityId -> commandId
  const devicesRef = useRef<DeviceView[]>([]);
  const lastSeq = useRef(0);
  const listeners = useRef(new Set<(event: HubEvent) => void>());
  devicesRef.current = devices;

  const setPendingCommand = useCallback((entityId: string, commandId: string | null) => {
    if (commandId) pendingRef.current.set(entityId, commandId);
    else pendingRef.current.delete(entityId);
    setPending(new Set(pendingRef.current.keys()));
  }, []);

  const markFailed = useCallback((entityId: string) => setFailures((f) => ({ ...f, [entityId]: (f[entityId] ?? 0) + 1 })), []);

  const signOut = useCallback(
    (message?: string) => {
      // An account session also ends on the hub (its cookie is HttpOnly, so only the hub can clear it).
      if (tokenRef.current === COOKIE_SESSION) void apiRequest('/customer/logout', { method: 'POST' }).catch(() => undefined);
      for (const key of Object.values(STORAGE)) localStorage.removeItem(key);
      tokenRef.current = null;
      setSession(null);
      setDevices([]);
      setHealth(null);
      if (message) toast(message, 'error');
    },
    [toast],
  );

  const signIn = useCallback(({ token, role, clientId }: PairResult) => {
    localStorage.setItem(STORAGE.token, token);
    localStorage.setItem(STORAGE.role, role);
    localStorage.setItem(STORAGE.clientId, clientId);
    tokenRef.current = token;
    setSession({ token, role, clientId });
  }, []);

  const api = useCallback(
    async <T,>(path: string, options?: ApiOptions): Promise<ApiResponse<T>> => {
      try {
        return await apiRequest<T>(path, options, tokenRef.current);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401 && tokenRef.current) signOut(REVOKED);
        throw err;
      }
    },
    [signOut],
  );

  const refresh = useCallback(async () => {
    try {
      const [d, h, me] = await Promise.all([api<DeviceView[]>('/devices'), api<HealthView>('/health'), api<{ role: Role; clientId: string }>('/me')]);
      setDevices(d.data);
      setHealth(h.data);
      // The owner may have promoted or demoted this browser: the hub's answer wins over the saved one.
      localStorage.setItem(STORAGE.role, me.data.role);
      setSession((s) => (s && s.role !== me.data.role ? { ...s, role: me.data.role } : s));
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) setConn('offline');
    }
  }, [api]);

  const settle = useCallback(
    (cmd: CommandView) => {
      if (pendingRef.current.get(cmd.entityId) !== cmd.commandId || !TERMINAL.has(cmd.status)) return;
      setPendingCommand(cmd.entityId, null);
      if (cmd.status === 'confirmed') return;
      const entity = devicesRef.current.flatMap((d) => d.entities).find((e) => e.entityId === cmd.entityId);
      toast(`${pretty(entity?.name ?? cmd.entityId)}: ${cmd.reason ?? cmd.status}`, 'error');
      markFailed(cmd.entityId);
    },
    [markFailed, setPendingCommand, toast],
  );

  const sendCommand = useCallback(
    async (entityId: string, value: boolean) => {
      if (pendingRef.current.has(entityId)) return;
      const commandId = uuid();
      setPendingCommand(entityId, commandId);
      try {
        const { status, data } = await api<CommandView>(`/entities/${encodeURIComponent(entityId)}/commands`, {
          method: 'POST',
          body: { commandId, value },
        });
        if (status === 410) throw new Error('Command expired before it could run');
        if (data) settle(data); // usually still pending; the WebSocket delivers the outcome
      } catch (err) {
        setPendingCommand(entityId, null);
        toast(err instanceof Error ? err.message : String(err), 'error');
        markFailed(entityId);
      }
    },
    [api, markFailed, setPendingCommand, settle, toast],
  );

  const applyEvent = useCallback(
    (ev: HubEvent) => {
      lastSeq.current = Math.max(lastSeq.current, ev.seq);
      for (const listener of listeners.current) listener(ev);
      const p = ev.payload;
      if (ev.type === 'entity.state') {
        const known = devicesRef.current.some((d) => d.entities.some((e) => e.entityId === p.entityId));
        if (!known) return void refresh();
        setDevices((ds) =>
          ds.map((d) => ({
            ...d,
            entities: d.entities.map((e) =>
              e.entityId === p.entityId ? { ...e, state: p.state as boolean | null, stateVersion: p.stateVersion as number, updatedAt: ev.createdAt } : e,
            ),
          })),
        );
      } else if (ev.type === 'device.online') {
        if (!devicesRef.current.some((d) => d.deviceId === p.deviceId)) return void refresh();
        setDevices((ds) => ds.map((d) => (d.deviceId === p.deviceId ? { ...d, online: p.online as boolean, lastSeen: ev.createdAt } : d)));
      } else if (ev.type === 'command.status') {
        settle(p as unknown as CommandView);
      }
    },
    [refresh, settle],
  );

  // Restore the saved session and learn which hub this is.
  useEffect(() => {
    const token = localStorage.getItem(STORAGE.token);
    if (token) {
      tokenRef.current = token;
      setSession({ token, role: (localStorage.getItem(STORAGE.role) as Role | null) ?? 'member', clientId: localStorage.getItem(STORAGE.clientId) });
    }
    setReady(true);
    apiRequest<HubIdentity>('/hub/identity').then((r) => setHub(r.data), () => {});
  }, []);

  // Live WebSocket while signed in: auth as the first message, resume from the last event seen,
  // reconnect with backoff, sign out if the hub revokes this client.
  const token = session?.token;
  useEffect(() => {
    if (!token) return;
    let closed = false;
    let ws: WebSocket | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (closed) return;
      const sock = new WebSocket(hubWebSocketUrl());
      ws = sock;
      sock.onopen = () => sock.send(JSON.stringify({ type: 'auth', token, resumeAfterSeq: lastSeq.current || undefined }));
      sock.onmessage = (m) => {
        const msg = JSON.parse(String(m.data)) as WsServerMessage;
        if (msg.type === 'ready') {
          retry = 0;
          setConn('live');
        } else if (msg.type === 'event') applyEvent(msg.event);
      };
      sock.onclose = (e) => {
        if (closed) return;
        if (e.code === 4401 || e.code === 4403) return signOut(REVOKED);
        setConn(retry > 1 ? 'offline' : 'connecting');
        const delay = Math.min(15_000, 500 * 2 ** retry++);
        timer = setTimeout(() => void refresh().finally(connect), delay);
      };
    };

    setConn('connecting');
    void refresh().finally(connect);
    return () => {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [token, applyEvent, refresh, signOut]);

  const onEvent = useCallback((listener: (event: HubEvent) => void) => {
    listeners.current.add(listener);
    return () => void listeners.current.delete(listener);
  }, []);

  const value = useMemo<HubContextValue>(
    () => ({
      ready,
      session,
      isOwner: session?.role === 'owner',
      hub,
      health,
      devices,
      conn,
      pending,
      failures,
      api,
      sendCommand,
      refresh,
      onEvent,
      signIn,
      signOut,
    }),
    [ready, session, hub, health, devices, conn, pending, failures, api, sendCommand, refresh, onEvent, signIn, signOut],
  );

  return <HubContext.Provider value={value}>{children}</HubContext.Provider>;
}

export function useHub(): HubContextValue {
  const ctx = useContext(HubContext);
  if (!ctx) throw new Error('useHub must be used inside <HubProvider>');
  return ctx;
}

/** Every entity with its device attached, in display order. */
export function useEntities(): EntityWithDevice[] {
  const { devices } = useHub();
  return useMemo(() => devices.flatMap((device) => device.entities.map((e) => ({ ...e, device }))), [devices]);
}
