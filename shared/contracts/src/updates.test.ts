import { describe, expect, it } from 'vitest';
import { compareVersions } from './updates.js';

describe('compareVersions', () => {
  it('orders numerically, not as text', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '10.0.0')).toBeLessThan(0);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('puts a pre-release before its release and orders pre-release parts', () => {
    expect(compareVersions('1.4.0-rc.1', '1.4.0')).toBeLessThan(0);
    expect(compareVersions('1.4.0-rc.2', '1.4.0-rc.10')).toBeLessThan(0);
    expect(compareVersions('1.4.0-beta', '1.4.0-alpha')).toBeGreaterThan(0);
    expect(compareVersions('1.4.0-rc', '1.4.0-rc.1')).toBeLessThan(0);
    expect(compareVersions('1.4.0-1', '1.4.0-alpha')).toBeLessThan(0);
  });

  it('refuses things that are not versions', () => {
    expect(() => compareVersions('1.2', '1.2.0')).toThrow(/not a version/);
    expect(() => compareVersions('1.2.3; rm -rf /', '1.2.3')).toThrow(/not a version/);
  });
});
