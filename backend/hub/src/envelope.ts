import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';
import {
  MAX_CLOCK_SKEW_MS,
  cloudEnvelopeSchema,
  maxLifetimeMs,
  signedEnvelopeSchema,
  type CloudEnvelope,
} from '@voltax/contracts';
import type { DB } from './db.js';

export type EnvelopeCheck = { ok: true; envelope: CloudEnvelope } | { ok: false; reason: string; envelopeId?: string };

export interface EnvelopeVerifierOptions {
  hubId: string;
  /** Pinned cloud command public key (PEM, Ed25519). Without it every envelope is refused. */
  publicKeyPem: string | null;
  /** Whether the hub clock is trustworthy (NTP synchronised). Without a trusted clock, refuse. */
  timeSynced: () => boolean;
  now?: () => number;
  onboardingChallenge?: (value: string) => boolean;
}

/**
 * First gate for anything from the cloud. Order matters:
 * shape -> signature over the exact received bytes -> payload schema -> addressed to this hub ->
 * trusted clock -> time window and lifetime -> single use (nonce).
 * Authorisation against the local support grant happens after this, in SupportGrants.
 */
export class EnvelopeVerifier {
  private key: KeyObject | null;
  private now: () => number;

  constructor(
    private db: DB,
    private opts: EnvelopeVerifierOptions,
  ) {
    this.key = opts.publicKeyPem ? createPublicKey(opts.publicKeyPem) : null;
    if (this.key && this.key.asymmetricKeyType !== 'ed25519') throw new Error('cloud command key must be Ed25519');
    this.now = opts.now ?? Date.now;
  }

  get configured(): boolean {
    return this.key !== null;
  }

  check(raw: unknown): EnvelopeCheck {
    if (!this.key) return { ok: false, reason: 'cloud link not configured' };
    const signed = signedEnvelopeSchema.safeParse(raw);
    if (!signed.success) return { ok: false, reason: 'malformed envelope' };

    let sigOk: boolean;
    try {
      sigOk = verifySignature(null, Buffer.from(signed.data.payload, 'utf8'), this.key, Buffer.from(signed.data.sig, 'base64'));
    } catch {
      sigOk = false;
    }
    if (!sigOk) return { ok: false, reason: 'bad signature' };

    let json: unknown;
    try {
      json = JSON.parse(signed.data.payload);
    } catch {
      return { ok: false, reason: 'malformed payload' };
    }
    const parsed = cloudEnvelopeSchema.safeParse(json);
    if (!parsed.success) return { ok: false, reason: 'malformed payload' };
    const env = parsed.data;
    const id = env.envelopeId;

    if (env.hubId !== this.opts.hubId) return { ok: false, reason: 'addressed to another hub', envelopeId: id };
    const bootstrap = env.type === 'customer.onboard' && env.actor.role === 'PLATFORM_SUPER_ADMIN' && this.opts.onboardingChallenge?.(env.challenge) === true;
    if (env.type === 'customer.onboard' && !bootstrap) return { ok: false, reason: 'invalid onboarding challenge', envelopeId: id };
    if (!bootstrap && !this.opts.timeSynced()) return { ok: false, reason: 'hub clock not synchronised', envelopeId: id };

    const now = this.now();
    if (!bootstrap && env.issuedAt > now + MAX_CLOCK_SKEW_MS) return { ok: false, reason: 'issued in the future', envelopeId: id };
    if (!bootstrap && env.expiresAt <= now) return { ok: false, reason: 'expired', envelopeId: id };
    if (env.expiresAt <= env.issuedAt || env.expiresAt - env.issuedAt > maxLifetimeMs(env.type)) {
      return { ok: false, reason: 'lifetime too long', envelopeId: id };
    }

    const fresh = this.db
      .prepare('INSERT OR IGNORE INTO cloud_nonces (envelope_id, expires_at) VALUES (?, ?)')
      .run(id, env.expiresAt + MAX_CLOCK_SKEW_MS).changes === 1;
    if (!fresh) return { ok: false, reason: 'replayed', envelopeId: id };

    return { ok: true, envelope: env };
  }

  pruneNonces(): number {
    return this.db.prepare('DELETE FROM cloud_nonces WHERE expires_at < ?').run(this.now()).changes;
  }
}
