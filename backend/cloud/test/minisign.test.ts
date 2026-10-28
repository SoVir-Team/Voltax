import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseMinisignPublicKey, verifyMinisign } from '../src/minisign.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/minisign/${name}`, import.meta.url));
const pub = parseMinisignPublicKey(fixture('test.pub').toString());
const message = fixture('release.json');
const prehashed = fixture('release.json.minisig').toString();
const legacy = fixture('release.json.legacy.minisig').toString();

describe('minisign verification (interop with minisign 0.11)', () => {
  it('reads the public key and its id like minisign prints it', () => {
    expect(pub.keyId).toBe('F0F24D409A9E93CB');
  });

  it('accepts the default prehashed signature and returns the trusted comment', () => {
    expect(verifyMinisign(message, prehashed, pub)).toEqual({ ok: true, trustedComment: 'voltax hub 1.4.0', prehashed: true });
  });

  it('accepts a legacy (not prehashed) signature', () => {
    expect(verifyMinisign(message, legacy, pub)).toMatchObject({ ok: true, trustedComment: 'voltax hub 1.4.0 legacy', prehashed: false });
  });

  it('refuses a changed file, a changed trusted comment, another key, and garbage', () => {
    const changed = Buffer.from(message.toString().replace('1.4.0', '1.4.1'));
    expect(verifyMinisign(changed, prehashed, pub)).toMatchObject({ ok: false, reason: 'signature does not match the file' });

    const forgedComment = prehashed.replace('trusted comment: voltax hub 1.4.0', 'trusted comment: voltax hub 9.9.9');
    expect(verifyMinisign(message, forgedComment, pub)).toMatchObject({ ok: false, reason: 'trusted comment signature does not match' });

    // Same structure, different key: the key id no longer matches.
    const other = generateKeyPairSync('ed25519');
    const raw = Buffer.from(other.publicKey.export({ format: 'jwk' }).x!, 'base64url');
    const otherPub = parseMinisignPublicKey(Buffer.concat([Buffer.from('Ed'), Buffer.alloc(8, 7), raw]).toString('base64'));
    expect(verifyMinisign(message, prehashed, otherPub)).toMatchObject({ ok: false, reason: 'signed with a different key' });

    // Right key id but a signature by another key (e.g. a stolen id): refused.
    const sig = sign(null, createHash('blake2b512').update(message).digest(), other.privateKey);
    const lines = prehashed.split('\n');
    const keyId = Buffer.from(lines[1]!, 'base64').subarray(2, 10);
    lines[1] = Buffer.concat([Buffer.from('ED'), keyId, sig]).toString('base64');
    expect(verifyMinisign(message, lines.join('\n'), pub)).toMatchObject({ ok: false, reason: 'signature does not match the file' });

    expect(verifyMinisign(message, 'not a signature', pub)).toMatchObject({ ok: false });
    expect(() => parseMinisignPublicKey('RWQ=')).toThrow(/not a minisign public key/);
  });
});
