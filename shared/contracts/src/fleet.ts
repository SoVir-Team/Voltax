import { z } from 'zod';
import type { UpdateState } from './cloud.js';
import { VERSION_PATTERN } from './updates.js';

// Fleet operations: signed release registry and staged hub rollouts (company portal).

const version = z.string().regex(VERSION_PATTERN, 'version must look like 1.2.3');
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const digestRef = z.string().regex(/^[a-z0-9./_-]+@sha256:[0-9a-f]{64}$/, 'image must be pinned by digest');

/** release.json as written and minisign-signed by .github/workflows/hub-release.yml. */
export const hubReleaseManifestSchema = z.object({
  version,
  hubImage: digestRef,
  mosquittoImage: digestRef,
  composeSha256: sha256Hex,
  commit: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  builtAt: z.string().max(40).optional(),
});

export const ESP32_BOARDS = ['esp32', 'esp32s3', 'esp32c3', 'esp32c6'] as const;
/** Signed manifest for an ESPHome firmware image. */
export const firmwareManifestSchema = z.object({
  version,
  board: z.enum(ESP32_BOARDS),
  sha256: sha256Hex,
  size: z.number().int().min(1).max(16 * 1024 * 1024),
  minHubVersion: version.optional(),
});

export const releaseCreateSchema = z.object({
  kind: z.enum(['hub', 'esp32']),
  /** The exact signed bytes (release.json or the firmware manifest). */
  manifest: z.string().min(2).max(16_384),
  /** The .minisig file contents. */
  signature: z.string().min(10).max(2_000),
  /** Hubs older than this must update to an intermediate release first. */
  minFromVersion: version.optional(),
  notes: z.string().trim().max(2_000).optional(),
});
export type ReleaseCreateInput = z.infer<typeof releaseCreateSchema>;

export interface ReleaseView {
  releaseId: string;
  kind: 'hub' | 'esp32';
  version: string;
  keyId: string;
  trustedComment: string;
  minFromVersion: string | null;
  board: string | null;
  notes: string | null;
  createdAt: number;
  createdBy: string;
  withdrawnAt: number | null;
}

export interface HubCompatibility {
  hubId: string;
  homeId: string;
  currentVersion: string | null;
  eligible: boolean;
  reason: string;
}

export const rolloutCreateSchema = z.object({
  releaseId: z.uuid(),
  /** Cumulative share of eligible hubs after the canary, in percent, ending at 100. */
  stages: z
    .array(z.number().int().min(1).max(100))
    .min(1)
    .max(6)
    .default([10, 50, 100])
    .refine((s) => s.every((v, i) => i === 0 || v > s[i - 1]!) && s[s.length - 1] === 100, 'stages must increase and end at 100'),
  /** Halt when failed or rolled-back hubs exceed this share of hubs offered so far. */
  maxFailureRate: z.number().min(0).max(0.5).default(0.1),
  /** Minimum time each stage runs (and healthy updated hubs must keep reporting) before the next. */
  healthWindowMinutes: z.number().int().min(1).max(7 * 24 * 60).default(60),
});
export type RolloutCreateInput = z.infer<typeof rolloutCreateSchema>;
export const rolloutActionSchema = z.object({ reason: z.string().trim().min(3).max(500) });

export type RolloutStatus = 'running' | 'halted' | 'completed' | 'cancelled';
export type RolloutTargetState = 'pending' | 'offered' | 'skipped' | UpdateState;

export interface RolloutTargetView {
  hubId: string;
  homeId: string;
  stage: number; // 0 = canary
  state: RolloutTargetState;
  fromVersion: string | null;
  detail: string | null;
  updatedAt: number;
}

export interface RolloutView {
  rolloutId: string;
  release: { releaseId: string; version: string };
  status: RolloutStatus;
  stage: number;
  stages: number[];
  maxFailureRate: number;
  healthWindowMinutes: number;
  stageStartedAt: number;
  haltReason: string | null;
  createdAt: number;
  createdBy: string;
  counts: Partial<Record<RolloutTargetState, number>>;
  targets?: RolloutTargetView[];
}
