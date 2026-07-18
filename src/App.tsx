import { RouterProvider } from 'react-router-dom';
import { router } from '@/routes';
import { AuthProvider } from '@/lib/auth';
import { ThemeProvider } from '@/lib/theme';
import { Starfield } from '@/components/illustrations/Starfield';
import { GatewayGate } from '@/components/gateway/GatewayGate';

export default function App() {
  return (
    <ThemeProvider>
      {/* night-sky overlay — fixed behind all routes, fades in with dark mode */}
      {/* fixed behind all routes; inset-0 sizes it to the viewport — avoid
          w-screen (100vw) which includes the scrollbar and causes phantom
          horizontal scroll on real devices. */}
      <Starfield className="starfield-global pointer-events-none fixed inset-0 w-full h-full" />
      {/* Desktop builds (and ?gateway= deep links) pick their gateway before
          anything talks to the network; web builds with VITE_API_BASE_URL
          pass straight through. */}
      <GatewayGate>
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </GatewayGate>
    </ThemeProvider>
  );
}
