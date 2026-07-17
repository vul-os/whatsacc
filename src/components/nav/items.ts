export type NavItem = { to: string; label: string; end?: boolean };

export const APP_NAV_ITEMS: NavItem[] = [
  { to: '/app', label: 'Dashboard', end: true },
  { to: '/app/access-points', label: 'Access points' },
  { to: '/app/devices', label: 'Devices' },
  { to: '/app/members', label: 'Members' },
  { to: '/app/grants', label: 'Temp access' },
  { to: '/app/analytics', label: 'Analytics' },
  { to: '/app/settings', label: 'Settings' },
];
