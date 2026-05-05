import { Navigate, Outlet } from 'react-router-dom';
import { AppSidebar } from '@/components/nav/AppSidebar';
import { AppTopBar } from '@/components/nav/AppTopBar';
import { useAuth } from '@/lib/auth';

export default function AppLayout() {
  const { signedIn, loading } = useAuth();
  if (loading) {
    return (
      <div className="min-h-screen bg-paper grid place-items-center text-ink/50 text-sm">
        Loading…
      </div>
    );
  }
  if (!signedIn) return <Navigate to="/login" replace />;

  return (
    <div className="min-h-screen bg-paper flex">
      <AppSidebar />
      <div className="flex-1 min-w-0 flex flex-col">
        <AppTopBar />
        <main className="flex-1 px-4 sm:px-6 lg:px-10 py-5 sm:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export function PageHeader({
  kicker,
  title,
  description,
  actions,
}: {
  kicker?: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="mb-6 sm:mb-8 flex flex-wrap items-end gap-x-6 gap-y-3 sm:gap-x-8 sm:gap-y-4 justify-between">
      <div className="min-w-0">
        {kicker && (
          <span className="text-[10px] sm:text-[11px] uppercase tracking-[0.22em] text-ink/55">
            {kicker}
          </span>
        )}
        <h1 className="font-display-tight text-3xl sm:text-4xl lg:text-5xl mt-1">{title}</h1>
        {description && (
          <p className="mt-2 sm:mt-3 text-sm sm:text-base text-ink/65 max-w-xl leading-relaxed">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}
