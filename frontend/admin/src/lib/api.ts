// The only way the portal talks to the cloud: same-origin JSON with the HttpOnly session cookie.
// The cloud refuses cross-origin writes and anything that is not JSON.

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: init.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = (await res.json().catch(() => null)) as {
    error?: string;
    message?: string;
  } | null;
  if (!res.ok) throw new ApiError(data?.message ?? `Request failed (${res.status})`, res.status, data?.error ?? 'error');
  return data as T;
}
