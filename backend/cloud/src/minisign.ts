import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';

// minisign (https://jedisct1.github.io/minisign/) verification, compatible with the minisign tool
// used to sign VOLTEX releases. Public key: base64("Ed" || keyId[8] || ed25519 key[32]).
// Signature file: untrusted comment, base64(alg[2] || keyId[8] || sig[64]), trusted comment,
// base64(global sig[64] over sig || trusted comment). alg "ED" = Ed25519 over BLAKE2b-512(file)
// (default since minisign 0.10); "Ed" = legacy, Ed25519 over the file itself.

export interface MinisignPublicKey {
  /** As minisign prints it: the 8 id bytes read little-endian, upper-case hex. */
  keyId: string;
  key: KeyObject;
}

export type MinisignResult = { ok: true; trustedComment: string; prehashed: boolean } | { ok: false; reason: string };

const keyIdHex = (bytes: Buffer) => Buffer.from(bytes).reverse().toString('hex').toUpperCase();

export function parseMinisignPublicKey(text: string): MinisignPublicKey {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('untrusted comment:'));
  const raw = Buffer.from(line ?? '', 'base64');
  if (raw.length !== 42 || raw.subarray(0, 2).toString('latin1') !== 'Ed') throw new Error('not a minisign public key');
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.subarray(10).toString('base64url') }, format: 'jwk' });
  return { keyId: keyIdHex(raw.subarray(2, 10)), key };
}

export function verifyMinisign(message: Buffer | string, signatureText: string, pub: MinisignPublicKey): MinisignResult {
  const lines = signatureText.split(/\r?\n/);
  if (lines.length < 4 || !lines[0]!.startsWith('untrusted comment:') || !lines[2]!.startsWith('trusted comment: ')) {
    return { ok: false, reason: 'not a minisign signature file' };
  }
  const sigBlob = Buffer.from(lines[1]!.trim(), 'base64');
  const global = Buffer.from(lines[3]!.trim(), 'base64');
  if (sigBlob.length !== 74 || global.length !== 64) return { ok: false, reason: 'not a minisign signature file' };
  const alg = sigBlob.subarray(0, 2).toString('latin1');
  if (alg !== 'ED' && alg !== 'Ed') return { ok: false, reason: `unsupported signature algorithm ${alg}` };
  if (keyIdHex(sigBlob.subarray(2, 10)) !== pub.keyId) return { ok: false, reason: 'signed with a different key' };
  const sig = sigBlob.subarray(10);
  const data = typeof message === 'string' ? Buffer.from(message) : message;
  const signed = alg === 'ED' ? createHash('blake2b512').update(data).digest() : data;
  if (!verify(null, signed, pub.key, sig)) return { ok: false, reason: 'signature does not match the file' };
  const trustedComment = lines[2]!.slice('trusted comment: '.length);
  if (!verify(null, Buffer.concat([sig, Buffer.from(trustedComment)]), pub.key, global)) return { ok: false, reason: 'trusted comment signature does not match' };
  return { ok: true, trustedComment, prehashed: alg === 'ED' };
}
