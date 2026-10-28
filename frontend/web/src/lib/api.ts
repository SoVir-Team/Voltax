// The only way the UI talks to the hub: its local REST API (/api/v1).

export const API_BASE = '/api/v1';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
}

export interface ApiResponse<T> {
  status: number;
  data: T;
}

/** Throws ApiError for any non-2xx except 410 (expired command), which callers handle themselves. */
export async function apiRequest<T>(path: string, { method = 'GET', body }: ApiOptions = {}, token?: string | null): Promise<ApiResponse<T>> {
  const res = await fetch(API_BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok && res.status !== 410) {
    const message = (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
    throw new ApiError(message, res.status);
  }
  return { status: res.status, data: data as T };
}

export function hubWebSocketUrl(): string {
  const origin = process.env.NEXT_PUBLIC_HUB_WS_ORIGIN ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  return `${origin}${API_BASE}/ws`;
}
