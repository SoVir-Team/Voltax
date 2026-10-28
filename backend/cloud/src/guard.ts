import { PLATFORM_PERMISSIONS, PLATFORM_ROLES, type PlatformAction, type PlatformScope } from '@voltax/contracts';

/**
 * Every /api route declares exactly one of these in `config.guard`; startup fails otherwise.
 * - public:  no session (allow-list below)
 * - setup:   any session, including one that has not finished two-factor enrolment
 * - self:    any fully signed-in staff member, acting on their own account
 * - action:  a platform permission from shared/contracts permissions.ts. Scopes are enforced here:
 *            'assigned'/'grant' need `home` (where the home id comes from) or `list` (the handler
 *            filters by req.scope); 'own' needs `own` (the handler checks ownership).
 */
export type CloudGuard =
  | { public: true }
  | { session: 'setup' | 'self' }
  | { action: PlatformAction; home?: 'params' | 'body' | 'query'; list?: true; own?: true };

export const PUBLIC_CLOUD_ROUTES = ['GET /api/v1/health', 'POST /api/v1/auth/login', 'POST /api/v1/auth/setup'] as const;

export function scopesOf(action: PlatformAction): PlatformScope[] {
  return PLATFORM_ROLES.map((r) => PLATFORM_PERMISSIONS[action][r]).filter((s): s is PlatformScope => Boolean(s));
}

export function assertCloudGuarded(method: string, url: string, guard: CloudGuard | undefined): void {
  if (!url.startsWith('/api/') || method === 'HEAD') return;
  const route = `${method} ${url}`;
  if (!guard) throw new Error(`route ${route} has no permission guard`);
  if ('public' in guard) {
    if (!(PUBLIC_CLOUD_ROUTES as readonly string[]).includes(route)) throw new Error(`route ${route} is not on the public allow-list`);
    return;
  }
  if ('session' in guard) return;
  if (!(guard.action in PLATFORM_PERMISSIONS)) throw new Error(`route ${route}: unknown action ${guard.action}`);
  const scopes = scopesOf(guard.action);
  if (scopes.length === 0) throw new Error(`route ${route}: no role may ${guard.action}`);
  if (scopes.some((s) => s === 'assigned' || s === 'grant') && !guard.home && !guard.list) {
    throw new Error(`route ${route}: ${guard.action} is assignment-scoped, so the route must say where the home id comes from`);
  }
  if (scopes.includes('own') && !guard.own) throw new Error(`route ${route}: ${guard.action} is ownership-scoped, so the handler must check ownership`);
}
