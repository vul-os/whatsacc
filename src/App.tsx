import { RouterProvider } from 'react-router-dom';
import { router } from '@/routes';
import { AuthProvider } from '@/lib/auth';
import { ThemeProvider } from '@/lib/theme';
import { Starfield } from '@/components/illustrations/Starfield';

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        {/* night-sky overlay — fixed behind all routes, fades in with dark mode */}
        {/* fixed behind all routes; inset-0 sizes it to the viewport — avoid
            w-screen (100vw) which includes the scrollbar and causes phantom
            horizontal scroll on real devices. */}
        <Starfield className="starfield-global pointer-events-none fixed inset-0 w-full h-full" />
        <RouterProvider router={router} />
      </AuthProvider>
    </ThemeProvider>
  );
}
