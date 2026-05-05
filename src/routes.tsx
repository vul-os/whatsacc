import { createBrowserRouter, type RouteObject } from 'react-router-dom';
import { lazy, Suspense, type ComponentType } from 'react';

function wrap(load: () => Promise<{ default: ComponentType }>) {
  const C = lazy(load);
  return (
    <Suspense fallback={<PageFallback />}>
      <C />
    </Suspense>
  );
}

function PageFallback() {
  return (
    <div className="min-h-screen bg-paper grid place-items-center">
      <span className="text-ink/40 text-sm uppercase tracking-[0.22em]">loading</span>
    </div>
  );
}

const routes: RouteObject[] = [
  { path: '/', element: wrap(() => import('@/pages/Landing')) },
  { path: '/pricing', element: wrap(() => import('@/pages/Pricing')) },
  { path: '/security', element: wrap(() => import('@/pages/Security')) },
  { path: '/login', element: wrap(() => import('@/pages/Login')) },
  { path: '/signup', element: wrap(() => import('@/pages/Signup')) },
  {
    path: '/docs',
    element: wrap(() => import('@/pages/docs/DocsLayout')),
    children: [
      { index: true, element: wrap(() => import('@/pages/docs/GettingStarted')) },
      { path: 'linking-whatsapp', element: wrap(() => import('@/pages/docs/LinkingWhatsApp')) },
      { path: 'locations', element: wrap(() => import('@/pages/docs/Locations')) },
      { path: 'pairing-device', element: wrap(() => import('@/pages/docs/PairingDevice')) },
      { path: 'permissions-members', element: wrap(() => import('@/pages/docs/PermissionsMembers')) },
      { path: 'geofence-safety', element: wrap(() => import('@/pages/docs/GeofenceSafety')) },
      { path: 'api-reference', element: wrap(() => import('@/pages/docs/ApiReference')) },
    ],
  },
  {
    path: '/app',
    element: wrap(() => import('@/pages/app/AppLayout')),
    children: [
      { index: true, element: wrap(() => import('@/pages/app/Dashboard')) },
      { path: 'open', element: wrap(() => import('@/pages/app/OpenGate')) },
      { path: 'locations', element: wrap(() => import('@/pages/app/Locations')) },
      { path: 'access-points', element: wrap(() => import('@/pages/app/AccessPoints')) },
      { path: 'devices', element: wrap(() => import('@/pages/app/Devices')) },
      { path: 'members', element: wrap(() => import('@/pages/app/Members')) },
      { path: 'billing', element: wrap(() => import('@/pages/app/Billing')) },
      { path: 'analytics', element: wrap(() => import('@/pages/app/Analytics')) },
    ],
  },
];

export const router = createBrowserRouter(routes);
