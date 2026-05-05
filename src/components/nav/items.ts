export type NavItem = { to: string; label: string; end?: boolean };

export const APP_NAV_ITEMS: NavItem[] = [
  { to: '/app', label: 'Dashboard', end: true },
  { to: '/app/locations', label: 'Locations' },
  { to: '/app/access-points', label: 'Access points' },
  { to: '/app/devices', label: 'Devices' },
  { to: '/app/members', label: 'Members' },
  { to: '/app/grants', label: 'Temp access' },
  { to: '/app/billing', label: 'Billing' },
  { to: '/app/analytics', label: 'Analytics' },
  { to: '/app/referrals', label: 'Referrals' },
  { to: '/app/security', label: 'Security' },
];
