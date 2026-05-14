import { RouterProvider } from 'react-router-dom';
import { router } from '@/routes';
import { AuthProvider } from '@/lib/auth';
import { CurrencyProvider } from '@/lib/billing/currency';
import { ThemeProvider } from '@/lib/theme';
import { Starfield } from '@/components/illustrations/Starfield';

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <CurrencyProvider>
          {/* night-sky overlay — fixed behind all routes, fades in with dark mode */}
          <Starfield className="starfield-global pointer-events-none fixed inset-0 w-screen h-screen" />
          <RouterProvider router={router} />
        </CurrencyProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
