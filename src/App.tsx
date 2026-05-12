import { RouterProvider } from 'react-router-dom';
import { router } from '@/routes';
import { AuthProvider } from '@/lib/auth';
import { CurrencyProvider } from '@/lib/billing/currency';
import { ThemeProvider } from '@/lib/theme';

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <CurrencyProvider>
          <RouterProvider router={router} />
        </CurrencyProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
