import { platformScope, type PlatformAction, type PlatformRole } from '@voltax/contracts';

export interface NavItem {
  href: string;
  label: string;
  icon: 'overview' | 'homes' | 'support' | 'fleet' | 'releases' | 'audit' | 'staff' | 'settings';
  /** Shown only to roles the permission matrix allows (the cloud enforces it anyway). */
  action: PlatformAction | null;
}

export const NAV: NavItem[] = [
  { href: '/', label: 'Overview', icon: 'overview', action: null },
  { href: '/homes/', label: 'Homes', icon: 'homes', action: 'home.read' },
  {
    href: '/grants/',
    label: 'Support access',
    icon: 'support',
    action: 'grant.read',
  },
  { href: '/fleet/', label: 'Fleet', icon: 'fleet', action: 'rollout.read' },
  {
    href: '/releases/',
    label: 'Releases',
    icon: 'releases',
    action: 'firmware.read',
  },
  { href: '/audit/', label: 'Audit', icon: 'audit', action: 'audit.read' },
  { href: '/staff/', label: 'Staff', icon: 'staff', action: 'staff.read' },
  { href: '/settings/', label: 'Settings', icon: 'settings', action: null },
];

export const navFor = (role: PlatformRole): NavItem[] => NAV.filter((n) => n.action === null || platformScope(role, n.action) !== null);

/** True when the role may do this anywhere (platform or on assigned homes). For hiding buttons only. */
export const can = (role: PlatformRole | undefined, action: PlatformAction): boolean => !!role && platformScope(role, action) !== null;

export const ROLE_LABEL: Record<PlatformRole, string> = {
  PLATFORM_SUPER_ADMIN: 'Super admin',
  PLATFORM_SUPPORT: 'Support',
  INSTALLER: 'Installer',
};
