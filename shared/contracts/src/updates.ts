import { z } from 'zod';
import type { UpdateState } from './cloud.js';

export const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9a-z.]+)?$/i;

/**
 * Orders release versions (x.y.z, optional -pre). A pre-release sorts before its release.
 * Returns <0, 0 or >0. Throws on anything that is not a version.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    if (!VERSION_PATTERN.test(v)) throw new Error(`not a version: ${v}`);
    const [core, pre] = v.split('-', 2) as [string, string | undefined];
    return { nums: core.split('.').map(Number), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i]! - y.nums[i]!;
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  const px = x.pre.split('.');
  const py = y.pre.split('.');
  for (let i = 0; i < Math.max(px.length, py.length); i++) {
    if (px[i] === undefined) return -1;
    if (py[i] === undefined) return 1;
    const nx = /^\d+$/.test(px[i]!) ? Number(px[i]) : NaN;
    const ny = /^\d+$/.test(py[i]!) ? Number(py[i]) : NaN;
    if (px[i] === py[i]) continue;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) return nx - ny;
    if (!Number.isNaN(nx)) return -1;
    if (!Number.isNaN(ny)) return 1;
    return px[i]! < py[i]! ? -1 : 1;
  }
  return 0;
}

// --- hub owner: update policy and offers (hub API) ----------------------------------------------

/** approve = every update waits for the owner (default); auto = signed updates install when offered. */
export const updatePolicySchema = z.enum(['approve', 'auto']);
export type UpdatePolicy = z.infer<typeof updatePolicySchema>;

export const updatePolicyBodySchema = z.object({ policy: updatePolicySchema }).strict();

export type UpdateOfferStatus = 'pending' | 'approved' | 'declined' | 'withdrawn';

export interface UpdateOfferView {
  rolloutId: string;
  version: string;
  offeredAt: number;
  offeredBy: string; // display name of the VOLTEX admin who started the rollout
  status: UpdateOfferStatus;
  decidedAt: number | null;
  decidedBy: string | null; // client id, or "policy:auto"
}

export interface HubUpdatesView {
  policy: UpdatePolicy;
  currentVersion: string;
  state: { state: UpdateState; version?: string };
  offers: UpdateOfferView[];
}
