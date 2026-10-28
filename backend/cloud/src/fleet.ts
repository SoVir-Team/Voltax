import { createHash, randomUUID } from 'node:crypto';
import {
  compareVersions,
  ENVELOPE_VERSION,
  firmwareManifestSchema,
  hubReleaseManifestSchema,
  MAX_ENVELOPE_LIFETIME_MS,
  VERSION_PATTERN,
  type Actor,
  type HubCompatibility,
  type HubMessage,
  type PlatformRole,
  type ReleaseCreateInput,
  type ReleaseView,
  type RolloutCreateInput,
  type RolloutTargetState,
  type RolloutTargetView,
  type RolloutView,
} from '@voltax/contracts';
import type { CloudAudit } from './audit.js';
import type { Db } from './db.js';
import { badRequest, conflict, notFound } from './errors.js';
import type { HubTransport } from './grants.js';
import { HUB_OFFLINE_AFTER_MS, parseTelemetry } from './homes.js';
import { parseMinisignPublicKey, verifyMinisign, type MinisignPublicKey } from './minisign.js';
import type { EnvelopeSigner } from './signer.js';

const SA: PlatformRole = 'PLATFORM_SUPER_ADMIN';
/** An offer nobody answered is sent again after this long (the hub may have been offline). */
export const REOFFER_MS = 10 * 60_000;
const TICK_MS = 15_000;

const TO_OFFER: RolloutTargetState[] = ['pending', 'withdrawn'];
const IN_PROGRESS: RolloutTargetState[] = ['pending', 'withdrawn', 'offered', 'requested', 'applying'];
const FAILED: RolloutTargetState[] = ['failed', 'rolled_back'];
const UNDECIDED: RolloutTargetState[] = ['offered', 'awaiting_approval'];

interface ReleaseRow {
  id: string;
  kind: 'hub' | 'esp32';
  version: string;
  key_id: string;
  trusted_comment: string;
  min_from_version: string | null;
  board: string | null;
  notes: string | null;
  created_at: number;
  created_by: string;
  withdrawn_at: number | null;
}

interface RolloutRow {
  id: string;
  release_id: string;
  status: RolloutView['status'];
  stages: string;
  stage: number;
  max_failure_rate: number;
  health_window_ms: number;
  stage_started_at: number;
  halt_reason: string | null;
  created_at: number;
  created_by: string;
  acting_admin: string;
}

interface TargetRow {
  hub_id: string;
  home_id: string;
  stage: number;
  state: RolloutTargetState;
  from_version: string | null;
  offered_at: number | null;
  updated_at: number;
  detail: string | null;
  telemetry: string | null;
}

/**
 * Signed release registry and staged hub rollouts. The cloud only OFFERS an update (a signed
 * envelope); each hub's owner policy decides, and the root updater on the Pi verifies the release
 * signature again. Rollouts go canary -> stages, halt on failures, and never offer a downgrade.
 */
export class FleetService {
  private releaseKey: MinisignPublicKey | null;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | null = null;
  /** Replaceable in tests (clock for rollout timing; envelopes always use the real clock). */
  now: () => number = Date.now;

  constructor(
    private db: Db,
    private audit: CloudAudit,
    private signer: EnvelopeSigner | null,
    public transport: HubTransport | null,
    releasePublicKey: string | null,
  ) {
    this.releaseKey = releasePublicKey ? parseMinisignPublicKey(releasePublicKey) : null;
  }

  start(): void {
    this.timer = setInterval(() => void this.tick().catch(() => undefined), TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  // --- releases --------------------------------------------------------------------------------

  async registerRelease(input: ReleaseCreateInput, staffId: string): Promise<ReleaseView> {
    const actor = `staff:${staffId}`;
    if (!this.releaseKey) throw conflict('no release public key is configured (RELEASE_PUBKEY_FILE)');
    const sig = verifyMinisign(input.manifest, input.signature, this.releaseKey);
    if (!sig.ok) {
      await this.audit.append({ actor, action: 'release.register', outcome: 'denied', details: { kind: input.kind, reason: sig.reason } });
      throw badRequest(`release signature refused: ${sig.reason}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(input.manifest);
    } catch {
      throw badRequest('manifest is not JSON');
    }
    const parsed = (input.kind === 'hub' ? hubReleaseManifestSchema : firmwareManifestSchema).safeParse(json);
    if (!parsed.success) throw badRequest(`manifest: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    const { version } = parsed.data;
    const board = 'board' in parsed.data ? parsed.data.board : null;
    if (input.minFromVersion && compareVersions(input.minFromVersion, version) >= 0) throw badRequest('minFromVersion must be older than the release');
    const [dup] = await this.db.query('SELECT 1 FROM releases WHERE kind = $1 AND version = $2', [input.kind, version]);
    if (dup) throw conflict(`${input.kind} ${version} is already registered`);
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO releases (id, kind, version, manifest, signature, key_id, trusted_comment, min_from_version, board, notes, created_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [id, input.kind, version, input.manifest, input.signature, this.releaseKey.keyId, sig.trustedComment, input.minFromVersion ?? null, board, input.notes ?? null, Date.now(), staffId],
    );
    await this.audit.append({ actor, action: 'release.register', outcome: 'ok', target: `release:${id}`, details: { kind: input.kind, version, keyId: this.releaseKey.keyId } });
    return (await this.release(id))!;
  }

  async listReleases(): Promise<ReleaseView[]> {
    return (await this.db.query<ReleaseRow>('SELECT * FROM releases ORDER BY created_at DESC LIMIT 200')).map(releaseView);
  }

  async release(id: string): Promise<ReleaseView | null> {
    const [r] = await this.db.query<ReleaseRow>('SELECT * FROM releases WHERE id = $1', [id]);
    return r ? releaseView(r) : null;
  }

  async withdrawRelease(id: string, reason: string, staffId: string): Promise<ReleaseView> {
    const r = await this.release(id);
    if (!r) throw notFound();
    if (r.withdrawnAt) throw conflict('already withdrawn');
    await this.db.query('UPDATE releases SET withdrawn_at = $2 WHERE id = $1', [id, Date.now()]);
    await this.audit.append({ actor: `staff:${staffId}`, action: 'release.withdraw', outcome: 'ok', target: `release:${id}`, details: { version: r.version, reason } });
    for (const ro of await this.db.query<RolloutRow>("SELECT * FROM rollouts WHERE release_id = $1 AND status = 'running'", [id])) {
      await this.halt(ro, `release withdrawn: ${reason}`, `staff:${staffId}`);
    }
    return (await this.release(id))!;
  }

  /** Which registered hubs could take this release now, and why not. */
  async compatibility(releaseId: string): Promise<HubCompatibility[]> {
    const [rel] = await this.db.query<ReleaseRow>('SELECT * FROM releases WHERE id = $1', [releaseId]);
    if (!rel) throw notFound();
    const rows = await this.db.query<{ hub_id: string; home_id: string; telemetry: string | null }>('SELECT hub_id, home_id, telemetry FROM hubs ORDER BY hub_id');
    return rows.map((h) => {
      const current = parseTelemetry(h.telemetry)?.version ?? null;
      const base = { hubId: h.hub_id, homeId: h.home_id, currentVersion: current };
      if (rel.kind !== 'hub') return { ...base, eligible: false, reason: 'ESP32 OTA delivery is not available until it is validated on hardware' };
      if (rel.withdrawn_at) return { ...base, eligible: false, reason: 'release withdrawn' };
      if (!current) return { ...base, eligible: false, reason: 'no telemetry yet' };
      if (!VERSION_PATTERN.test(current)) return { ...base, eligible: false, reason: 'not running a release version' };
      if (compareVersions(current, rel.version) >= 0) return { ...base, eligible: false, reason: 'already on this version or newer' };
      if (rel.min_from_version && compareVersions(current, rel.min_from_version) < 0) return { ...base, eligible: false, reason: `needs ${rel.min_from_version} or later first` };
      return { ...base, eligible: true, reason: 'eligible' };
    });
  }

  // --- rollouts --------------------------------------------------------------------------------

  async createRollout(input: RolloutCreateInput, staffId: string): Promise<RolloutView> {
    const [rel] = await this.db.query<ReleaseRow>('SELECT * FROM releases WHERE id = $1', [input.releaseId]);
    if (!rel) throw notFound();
    if (rel.kind !== 'hub') throw conflict('ESP32 firmware rollouts are not available until OTA delivery is validated on hardware (production gate)');
    if (rel.withdrawn_at) throw conflict('this release was withdrawn');
    if (!this.signer) throw conflict('no command signing key: remote updates are disabled');
    const [active] = await this.db.query("SELECT id FROM rollouts WHERE status IN ('running', 'halted')");
    if (active) throw conflict('another rollout is active: finish, halt and cancel it first');
    const compat = await this.compatibility(rel.id);
    const id = randomUUID();
    const order = (h: string) => createHash('sha256').update(`${id}:${h}`).digest('hex'); // unbiased, fixed per rollout
    const eligible = compat.filter((h) => h.eligible).sort((a, b) => (order(a.hubId) < order(b.hubId) ? -1 : 1));
    if (eligible.length === 0) throw conflict('no hub is eligible for this release');
    const n = eligible.length;
    const cumulative = [1, ...input.stages.map((p) => Math.max(1, Math.ceil((p * n) / 100)))];
    const now = this.now();
    await this.db.tx(async (t) => {
      await t.query(
        `INSERT INTO rollouts (id, release_id, status, stages, stage, max_failure_rate, health_window_ms, stage_started_at, created_at, created_by, acting_admin, updated_at)
         VALUES ($1, $2, 'running', $3, 0, $4, $5, $6, $6, $7, $7, $6)`,
        [id, rel.id, JSON.stringify(input.stages), input.maxFailureRate, input.healthWindowMinutes * 60_000, now, staffId],
      );
      for (const [i, h] of eligible.entries()) {
        const stage = cumulative.findIndex((c) => i < c);
        await t.query("INSERT INTO rollout_targets (rollout_id, hub_id, stage, state, from_version, updated_at) VALUES ($1, $2, $3, 'pending', $4, $5)", [id, h.hubId, stage, h.currentVersion, now]);
      }
      for (const h of compat.filter((x) => !x.eligible)) {
        await t.query("INSERT INTO rollout_targets (rollout_id, hub_id, stage, state, from_version, updated_at, detail) VALUES ($1, $2, -1, 'skipped', $3, $4, $5)", [id, h.hubId, h.currentVersion, now, h.reason]);
      }
    });
    await this.audit.append({
      actor: `staff:${staffId}`,
      action: 'rollout.create',
      outcome: 'ok',
      target: `rollout:${id}`,
      details: { version: rel.version, eligible: n, skipped: compat.length - n, stages: input.stages, maxFailureRate: input.maxFailureRate, healthWindowMinutes: input.healthWindowMinutes },
    });
    await this.tick();
    return (await this.get(id))!;
  }

  async list(): Promise<RolloutView[]> {
    const rows = await this.db.query<{ id: string }>('SELECT id FROM rollouts ORDER BY created_at DESC LIMIT 50');
    return Promise.all(rows.map(async (r) => (await this.get(r.id))!));
  }

  async get(id: string, withTargets = false): Promise<RolloutView | null> {
    const [r] = await this.db.query<RolloutRow & { version: string }>('SELECT r.*, rel.version FROM rollouts r JOIN releases rel ON rel.id = r.release_id WHERE r.id = $1', [id]);
    if (!r) return null;
    const counts: RolloutView['counts'] = {};
    for (const c of await this.db.query<{ state: RolloutTargetState; n: number }>('SELECT state, count(*)::int AS n FROM rollout_targets WHERE rollout_id = $1 GROUP BY state', [id])) counts[c.state] = Number(c.n);
    const view: RolloutView = {
      rolloutId: r.id,
      release: { releaseId: r.release_id, version: r.version },
      status: r.status,
      stage: r.stage,
      stages: JSON.parse(r.stages) as number[],
      maxFailureRate: Number(r.max_failure_rate),
      healthWindowMinutes: Number(r.health_window_ms) / 60_000,
      stageStartedAt: Number(r.stage_started_at),
      haltReason: r.halt_reason,
      createdAt: Number(r.created_at),
      createdBy: r.created_by,
      counts,
    };
    if (withTargets) view.targets = (await this.targets(id)).map(targetView);
    return view;
  }

  async halt(rolloutOrId: RolloutRow | string, reason: string, actor: string): Promise<RolloutView> {
    const r = typeof rolloutOrId === 'string' ? await this.row(rolloutOrId) : rolloutOrId;
    if (r.status !== 'running') throw conflict(`rollout is ${r.status}`);
    await this.db.query("UPDATE rollouts SET status = 'halted', halt_reason = $2, updated_at = $3 WHERE id = $1", [r.id, reason, this.now()]);
    await this.audit.append({ actor, action: 'rollout.halt', outcome: 'ok', target: `rollout:${r.id}`, details: { reason } });
    await this.withdrawUndecided(r);
    return (await this.get(r.id))!;
  }

  async resume(id: string, reason: string, staffId: string): Promise<RolloutView> {
    const r = await this.row(id);
    if (r.status !== 'halted') throw conflict(`rollout is ${r.status}`);
    const [rel] = await this.db.query<ReleaseRow>('SELECT * FROM releases WHERE id = $1', [r.release_id]);
    if (rel?.withdrawn_at) throw conflict('this release was withdrawn');
    // The admin who resumes takes responsibility: later offers are signed in their name.
    await this.db.query("UPDATE rollouts SET status = 'running', halt_reason = NULL, acting_admin = $2, stage_started_at = $3, updated_at = $3 WHERE id = $1", [id, staffId, this.now()]);
    await this.audit.append({ actor: `staff:${staffId}`, action: 'rollout.resume', outcome: 'ok', target: `rollout:${id}`, details: { reason } });
    await this.tick();
    return (await this.get(id))!;
  }

  async cancel(id: string, reason: string, staffId: string): Promise<RolloutView> {
    const r = await this.row(id);
    if (r.status !== 'running' && r.status !== 'halted') throw conflict(`rollout is ${r.status}`);
    await this.db.query("UPDATE rollouts SET status = 'cancelled', halt_reason = $2, updated_at = $3 WHERE id = $1", [id, reason, this.now()]);
    await this.db.query("UPDATE rollout_targets SET state = 'skipped', detail = 'rollout cancelled', updated_at = $2 WHERE rollout_id = $1 AND state IN ('pending', 'withdrawn')", [id, this.now()]);
    await this.audit.append({ actor: `staff:${staffId}`, action: 'rollout.cancel', outcome: 'ok', target: `rollout:${id}`, details: { reason } });
    await this.withdrawUndecided(r);
    return (await this.get(id))!;
  }

  /** update.status from a hub (hub id from the broker topic). Only targets of that rollout count. */
  async onUpdateStatus(hubId: string, msg: Extract<HubMessage, { type: 'update.status' }>): Promise<void> {
    if (!msg.rolloutId || msg.state === 'idle') return;
    const [t] = await this.db.query<{ state: RolloutTargetState }>('SELECT state FROM rollout_targets WHERE rollout_id = $1 AND hub_id = $2', [msg.rolloutId, hubId]);
    // A hub answers only an offer it was sent: unknown, skipped or not-yet-offered targets change nothing.
    if (!t || t.state === 'skipped' || t.state === 'pending') {
      await this.audit.append({ actor: `hub:${hubId}`, action: 'rollout.status', outcome: 'denied', target: `rollout:${msg.rolloutId}`, details: { reason: 'hub was not offered this rollout', state: msg.state } });
      return;
    }
    if (t.state === msg.state) return;
    await this.db.query('UPDATE rollout_targets SET state = $3, detail = NULL, updated_at = $4 WHERE rollout_id = $1 AND hub_id = $2', [msg.rolloutId, hubId, msg.state, this.now()]);
    if (['done', 'failed', 'rolled_back', 'declined'].includes(msg.state)) {
      await this.audit.append({ actor: `hub:${hubId}`, action: 'rollout.status', outcome: msg.state === 'failed' || msg.state === 'rolled_back' ? 'error' : 'ok', target: `rollout:${msg.rolloutId}`, details: { state: msg.state, version: msg.version } });
    }
  }

  /** Fleet overview: counts only (versions, update states, online), no household data. */
  async summary(): Promise<{ hubs: number; online: number; versions: Record<string, number>; updateStates: Record<string, number>; activeRollout: string | null }> {
    const rows = await this.db.query<{ telemetry: string | null; last_seen_at: number | null }>('SELECT telemetry, last_seen_at FROM hubs');
    const versions: Record<string, number> = {};
    const updateStates: Record<string, number> = {};
    let online = 0;
    for (const r of rows) {
      const t = parseTelemetry(r.telemetry);
      const v = t?.version ?? 'unknown';
      versions[v] = (versions[v] ?? 0) + 1;
      const s = t?.update.state ?? 'unknown';
      updateStates[s] = (updateStates[s] ?? 0) + 1;
      if (r.last_seen_at !== null && Date.now() - Number(r.last_seen_at) < HUB_OFFLINE_AFTER_MS) online++;
    }
    const [active] = await this.db.query<{ id: string }>("SELECT id FROM rollouts WHERE status IN ('running', 'halted') LIMIT 1");
    return { hubs: rows.length, online, versions, updateStates, activeRollout: active?.id ?? null };
  }

  /** One pass over running rollouts. Serialised: overlapping ticks wait for the previous one. */
  async tick(): Promise<void> {
    const prev = this.running ?? Promise.resolve();
    const next = prev.then(async () => {
      for (const r of await this.db.query<RolloutRow>("SELECT * FROM rollouts WHERE status = 'running'")) await this.step(r);
    });
    this.running = next.catch(() => undefined);
    await next;
  }

  private async step(r: RolloutRow): Promise<void> {
    const [rel] = await this.db.query<ReleaseRow>('SELECT * FROM releases WHERE id = $1', [r.release_id]);
    if (rel!.withdrawn_at) return void (await this.halt(r, 'release withdrawn', 'system'));
    // Execution-time check: offers go out in the acting admin's name only while they still may.
    const [admin] = await this.db.query<{ id: string; role: PlatformRole; display_name: string; disabled_at: number | null }>('SELECT id, role, display_name, disabled_at FROM staff WHERE id = $1', [r.acting_admin]);
    if (!admin || admin.role !== SA || admin.disabled_at) return void (await this.halt(r, 'the acting admin is no longer a super admin; another super admin must resume', 'system'));
    const actor: Actor = { staffId: admin.id, role: admin.role, displayName: admin.display_name };

    const stages = JSON.parse(r.stages) as number[];
    const now = this.now();
    let targets = (await this.targets(r.id)).filter((t) => t.stage >= 0 && t.stage <= r.stage);
    if (await this.overThreshold(r, targets)) return;

    for (const t of targets) {
      const resend = t.state === 'offered' && t.offered_at !== null && now - Number(t.offered_at) > REOFFER_MS;
      if (TO_OFFER.includes(t.state) || resend) await this.offer(r, rel!, t.hub_id, actor);
    }

    // Stage gate: window over, nothing still in progress, updated hubs report the new version.
    if (now - Number(r.stage_started_at) < Number(r.health_window_ms)) return;
    targets = (await this.targets(r.id)).filter((t) => t.stage >= 0 && t.stage <= r.stage);
    if (targets.some((t) => IN_PROGRESS.includes(t.state))) return;
    for (const t of targets.filter((x) => x.state === 'done')) {
      const reported = parseTelemetry(t.telemetry)?.version ?? null;
      if (reported !== rel!.version) {
        await this.db.query("UPDATE rollout_targets SET state = 'failed', detail = $3, updated_at = $4 WHERE rollout_id = $1 AND hub_id = $2", [
          r.id,
          t.hub_id,
          `reported done but still reports ${reported ?? 'no version'} after the health window`,
          now,
        ]);
        t.state = 'failed';
      }
    }
    if (await this.overThreshold(r, targets)) return;
    if (!targets.some((t) => t.state === 'done')) return; // no healthy update yet: no evidence to go on

    if (r.stage >= stages.length) {
      await this.db.query("UPDATE rollouts SET status = 'completed', updated_at = $2 WHERE id = $1", [r.id, now]);
      await this.audit.append({ actor: 'system', action: 'rollout.complete', outcome: 'ok', target: `rollout:${r.id}`, details: { version: rel!.version } });
      return;
    }
    await this.db.query('UPDATE rollouts SET stage = $2, stage_started_at = $3, updated_at = $3 WHERE id = $1', [r.id, r.stage + 1, now]);
    await this.audit.append({ actor: 'system', action: 'rollout.stage', outcome: 'ok', target: `rollout:${r.id}`, details: { from: r.stage, to: r.stage + 1, percent: stages[r.stage] } });
    await this.step({ ...r, stage: r.stage + 1, stage_started_at: now });
  }

  /** Halts on any canary failure, or when failures exceed the allowed share of hubs offered so far. */
  private async overThreshold(r: RolloutRow, targets: TargetRow[]): Promise<boolean> {
    const failed = targets.filter((t) => FAILED.includes(t.state));
    if (failed.length === 0) return false;
    const canary = failed.some((t) => t.stage === 0);
    if (!canary && failed.length / targets.length <= Number(r.max_failure_rate)) return false;
    await this.halt(r, `failure threshold reached: ${failed.length} of ${targets.length} hubs failed or rolled back${canary ? ' (canary)' : ''}`, 'system');
    return true;
  }

  private async offer(r: RolloutRow, rel: ReleaseRow, hubId: string, actor: Actor): Promise<void> {
    if (!this.signer || !this.transport) return;
    const issuedAt = Date.now(); // real clock: the hub checks expiry against its own
    const env = this.signer.sign({ v: ENVELOPE_VERSION, envelopeId: randomUUID(), hubId, issuedAt, expiresAt: issuedAt + MAX_ENVELOPE_LIFETIME_MS - 30_000, actor, type: 'hub.update', rolloutId: r.id, version: rel.version });
    try {
      await this.transport.publish(hubId, env);
      await this.db.query("UPDATE rollout_targets SET state = 'offered', offered_at = $3, detail = NULL, updated_at = $3 WHERE rollout_id = $1 AND hub_id = $2", [r.id, hubId, this.now()]);
    } catch {
      await this.db.query("UPDATE rollout_targets SET detail = 'hub not reachable; will retry', updated_at = $3 WHERE rollout_id = $1 AND hub_id = $2", [r.id, hubId, this.now()]);
    }
  }

  /** Best effort: takes back offers the owners have not decided (hubs that are offline keep theirs). */
  private async withdrawUndecided(r: RolloutRow): Promise<void> {
    if (!this.signer || !this.transport) return;
    const [admin] = await this.db.query<{ id: string; role: PlatformRole; display_name: string }>('SELECT id, role, display_name FROM staff WHERE id = $1', [r.acting_admin]);
    for (const t of (await this.targets(r.id)).filter((x) => UNDECIDED.includes(x.state))) {
      const issuedAt = Date.now();
      const env = this.signer.sign({
        v: ENVELOPE_VERSION,
        envelopeId: randomUUID(),
        hubId: t.hub_id,
        issuedAt,
        expiresAt: issuedAt + MAX_ENVELOPE_LIFETIME_MS - 30_000,
        actor: { staffId: admin!.id, role: SA, displayName: admin!.display_name },
        type: 'hub.update.withdraw',
        rolloutId: r.id,
      });
      try {
        await this.transport.publish(t.hub_id, env);
        await this.db.query("UPDATE rollout_targets SET state = 'withdrawn', updated_at = $3 WHERE rollout_id = $1 AND hub_id = $2", [r.id, t.hub_id, this.now()]);
      } catch {
        await this.db.query("UPDATE rollout_targets SET detail = 'withdrawal not delivered (hub offline)', updated_at = $3 WHERE rollout_id = $1 AND hub_id = $2", [r.id, t.hub_id, this.now()]);
      }
    }
  }

  private async row(id: string): Promise<RolloutRow> {
    const [r] = await this.db.query<RolloutRow>('SELECT * FROM rollouts WHERE id = $1', [id]);
    if (!r) throw notFound();
    return r;
  }

  private targets(id: string): Promise<TargetRow[]> {
    return this.db.query<TargetRow>(
      'SELECT t.*, h.home_id, h.telemetry FROM rollout_targets t JOIN hubs h ON h.hub_id = t.hub_id WHERE t.rollout_id = $1 ORDER BY t.stage, t.hub_id',
      [id],
    );
  }
}

function releaseView(r: ReleaseRow): ReleaseView {
  return {
    releaseId: r.id,
    kind: r.kind,
    version: r.version,
    keyId: r.key_id,
    trustedComment: r.trusted_comment,
    minFromVersion: r.min_from_version,
    board: r.board,
    notes: r.notes,
    createdAt: Number(r.created_at),
    createdBy: r.created_by,
    withdrawnAt: r.withdrawn_at === null ? null : Number(r.withdrawn_at),
  };
}

function targetView(t: TargetRow): RolloutTargetView {
  return { hubId: t.hub_id, homeId: t.home_id, stage: t.stage, state: t.state, fromVersion: t.from_version, detail: t.detail, updatedAt: Number(t.updated_at) };
}
