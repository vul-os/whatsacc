import { RouterProvider } from 'react-router-dom';
import { router } from '@/routes';
import { AuthProvider } from '@/lib/auth';
import { CurrencyProvider } from '@/lib/billing/currency';

export default function App() {
  return (
    <AuthProvider>
      <CurrencyProvider>
        <RouterProvider router={router} />
      </CurrencyProvider>
    </AuthProvider>
  );
}
