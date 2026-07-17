import { createBrowserRouter, type RouteObject } from 'react-router-dom';
import { lazy, Suspense, type ComponentType } from 'react';
import ChunkLoadBoundary from '@/components/ChunkLoadBoundary';

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

// Every lazy-loaded route gets the same boundary. When a deploy lands while
// users have an old `index.html` cached, their next nav hits a 404 chunk
// and the boundary reloads them onto the new bundle.
const errorElement = <ChunkLoadBoundary />;

const routes: RouteObject[] = [
  { path: '/', element: wrap(() => import('@/pages/Landing')), errorElement },
  { path: '/security', element: wrap(() => import('@/pages/Security')), errorElement },
  { path: '/login', element: wrap(() => import('@/pages/Login')), errorElement },
  { path: '/signup', element: wrap(() => import('@/pages/Signup')), errorElement },
  { path: '/forgot-password', element: wrap(() => import('@/pages/ForgotPassword')), errorElement },
  { path: '/reset-password', element: wrap(() => import('@/pages/ResetPassword')), errorElement },
  { path: '/auth/verify-email', element: wrap(() => import('@/pages/VerifyEmail')), errorElement },
  { path: '/auth/callback', element: wrap(() => import('@/pages/AuthCallback')), errorElement },
  { path: '/accept-invite', element: wrap(() => import('@/pages/AcceptInvite')), errorElement },
  {
    path: '/docs',
    element: wrap(() => import('@/pages/docs/DocsLayout')),
    errorElement,
    children: [
      { index: true, element: wrap(() => import('@/pages/docs/GettingStarted')), errorElement },
      { path: 'linking-whatsapp', element: wrap(() => import('@/pages/docs/LinkingWhatsApp')), errorElement },
      { path: 'locations', element: wrap(() => import('@/pages/docs/Locations')), errorElement },
      { path: 'pairing-device', element: wrap(() => import('@/pages/docs/PairingDevice')), errorElement },
      { path: 'permissions-members', element: wrap(() => import('@/pages/docs/PermissionsMembers')), errorElement },
      { path: 'geofence-safety', element: wrap(() => import('@/pages/docs/GeofenceSafety')), errorElement },
      { path: 'api-reference', element: wrap(() => import('@/pages/docs/ApiReference')), errorElement },
    ],
  },
  {
    path: '/app',
    element: wrap(() => import('@/pages/app/AppLayout')),
    errorElement,
    children: [
      { index: true, element: wrap(() => import('@/pages/app/Dashboard')), errorElement },
      { path: 'open', element: wrap(() => import('@/pages/app/OpenGate')), errorElement },
      { path: 'access-points', element: wrap(() => import('@/pages/app/AccessPoints')), errorElement },
      { path: 'access-points/:id', element: wrap(() => import('@/pages/app/AccessPoint')), errorElement },
      { path: 'devices', element: wrap(() => import('@/pages/app/Devices')), errorElement },
      { path: 'members', element: wrap(() => import('@/pages/app/Members')), errorElement },
      { path: 'analytics', element: wrap(() => import('@/pages/app/Analytics')), errorElement },
      { path: 'grants', element: wrap(() => import('@/pages/app/Grants')), errorElement },
      { path: 'settings', element: wrap(() => import('@/pages/app/Settings')), errorElement },
    ],
  },
];

export const router = createBrowserRouter(routes);
