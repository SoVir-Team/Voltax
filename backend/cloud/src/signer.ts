import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { cloudEnvelopeSchema, type CloudEnvelope, type SignedEnvelope } from '@voltax/contracts';

/**
 * Signs envelopes for hubs with the cloud command key (Ed25519). The hub verifies the signature over
 * the exact payload bytes against its pinned public key, then re-checks everything else itself.
 */
export class EnvelopeSigner {
  private key: KeyObject;
  readonly publicKeyPem: string;
  readonly keyId: string;

  constructor(privateKeyPem: string) {
    this.key = createPrivateKey(privateKeyPem);
    if (this.key.asymmetricKeyType !== 'ed25519') throw new Error('command key must be Ed25519');
    const pub = createPublicKey(this.key);
    this.publicKeyPem = pub.export({ type: 'spki', format: 'pem' }).toString();
    this.keyId = createHash('sha256').update(pub.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
  }

  sign(envelope: CloudEnvelope): SignedEnvelope {
    // Validate before signing: the cloud never signs something the hub would reject as malformed.
    const checked = cloudEnvelopeSchema.parse(envelope);
    const payload = JSON.stringify(checked);
    return { payload, sig: sign(null, Buffer.from(payload, 'utf8'), this.key).toString('base64') };
  }

  /** Detached signature over arbitrary text (audit checkpoints use their own key and this helper). */
  signText(text: string): string {
    return sign(null, Buffer.from(text, 'utf8'), this.key).toString('base64');
  }
}
