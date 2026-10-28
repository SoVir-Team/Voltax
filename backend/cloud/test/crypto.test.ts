import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertCloudGuarded } from '../src/guard.js';
import { base32Decode, base32Encode, hashPassword, seal, totpAt, unseal, verifyPassword, verifyTotp } from '../src/crypto.js';
import { redact } from '../src/audit.js';

describe('crypto', () => {
  it('TOTP matches the RFC 6238 SHA-1 test vectors (6-digit truncation)', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    // RFC 6238 appendix B: T=59 -> 94287082, T=1111111109 -> 07081804, T=2000000000 -> 69279037
    expect(totpAt(secret, Math.floor(59 / 30))).toBe('287082');
    expect(totpAt(secret, Math.floor(1111111109 / 30))).toBe('081804');
    expect(totpAt(secret, Math.floor(2000000000 / 30))).toBe('279037');
  });

  it('TOTP accepts one step of drift either way, nothing further, and rejects junk', () => {
    const secret = base32Encode(randomBytes(20));
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30_000);
    expect(verifyTotp(secret, totpAt(secret, step), now)).toBe(step);
    expect(verifyTotp(secret, totpAt(secret, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(secret, totpAt(secret, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(secret, totpAt(secret, step - 2), now)).toBeNull();
    expect(verifyTotp(secret, '12345', now)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', now)).toBeNull();
  });

  it('base32 round-trips', () => {
    const buf = randomBytes(20);
    expect(base32Decode(base32Encode(buf))).toEqual(buf);
  });

  it('sealed secrets decrypt only with the right key and fail if tampered', () => {
    const key = randomBytes(32);
    const sealed = seal(key, 'JBSWY3DPEHPK3PXP');
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP');
    expect(unseal(key, sealed)).toBe('JBSWY3DPEHPK3PXP');
    expect(() => unseal(randomBytes(32), sealed)).toThrow();
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered!').toString('base64');
    expect(() => unseal(key, parts.join('.'))).toThrow();
  });

  it('scrypt hashes verify only the right password and are salted', async () => {
    const cost = { N: 1024, r: 8, p: 1 };
    const a = await hashPassword('a long enough password', cost);
    const b = await hashPassword('a long enough password', cost);
    expect(a).not.toBe(b);
    expect(await verifyPassword('a long enough password', a)).toBe(true);
    expect(await verifyPassword('a long enough passworD', a)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });

  it('audit redaction drops credentials at any depth', () => {
    const out = JSON.stringify(
      redact({ email: 'a@b.c', password: 'hunter2hunter2', nested: { setupToken: 'tok', totpCode: '123456', list: [{ sessionId: 's' }] }, code: '654321' }),
    );
    for (const secret of ['hunter2hunter2', 'tok"', '123456', '"s"', '654321']) expect(out).not.toContain(secret);
    expect(out).toContain('a@b.c');
  });
});

describe('route guard registration (deny-by-default)', () => {
  it('refuses unguarded routes, unlisted public routes, and scoped actions without a resolver', () => {
    expect(() => assertCloudGuarded('GET', '/api/v1/x', undefined)).toThrow(/no permission guard/);
    expect(() => assertCloudGuarded('POST', '/api/v1/debug', { public: true })).toThrow(/public allow-list/);
    expect(() => assertCloudGuarded('GET', '/api/v1/homes/:homeId', { action: 'home.read' })).toThrow(/assignment-scoped/);
    expect(() => assertCloudGuarded('POST', '/api/v1/grants/:id/revoke', { action: 'grant.revoke', home: 'params' })).toThrow(/ownership-scoped/);
    expect(() => assertCloudGuarded('GET', '/api/v1/staff', { action: 'staff.read' })).not.toThrow();
    expect(() => assertCloudGuarded('GET', '/healthz', undefined)).not.toThrow(); // non-API (static UI)
  });
});
