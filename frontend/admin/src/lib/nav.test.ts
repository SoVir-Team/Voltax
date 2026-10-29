import { describe, expect, it } from 'vitest';
import { can, navFor } from './nav';

describe('navigation follows the permission matrix', () => {
  const labels = (role: Parameters<typeof navFor>[0]) => navFor(role).map((n) => n.label);

  it('the super admin sees everything', () => {
    expect(labels('PLATFORM_SUPER_ADMIN')).toEqual(['Overview', 'Homes', 'Support access', 'Fleet', 'Releases', 'Audit', 'Staff', 'Settings']);
  });

  it('support has no staff management or audit; installers no fleet', () => {
    expect(labels('PLATFORM_SUPPORT')).not.toContain('Staff');
    expect(labels('PLATFORM_SUPPORT')).not.toContain('Audit');
    expect(labels('INSTALLER')).not.toContain('Fleet');
    expect(labels('INSTALLER')).toContain('Releases'); // firmware compatibility for installs
  });

  it('only the super admin manages releases and rollouts', () => {
    expect(can('PLATFORM_SUPER_ADMIN', 'rollout.manage')).toBe(true);
    expect(can('PLATFORM_SUPPORT', 'rollout.manage')).toBe(false);
    expect(can('INSTALLER', 'firmware.manage')).toBe(false);
    expect(can(undefined, 'home.read')).toBe(false);
  });
});
