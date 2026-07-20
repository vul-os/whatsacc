import { useState, useEffect } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { AppSidebar } from '@/components/nav/AppSidebar';
import { AppTopBar } from '@/components/nav/AppTopBar';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { CreateLocationModal } from '@/components/locations/CreateLocationModal';

export default function AppLayout() {
  const { signedIn, loading, currentAccount, setCurrentAccount, refreshMe } = useAuth();
  // null = still checking, false = has locations, true = needs setup
  const [needsLocationSetup, setNeedsLocationSetup] = useState<boolean | null>(null);

  useEffect(() => {
    if (!signedIn || !currentAccount) return;
    setNeedsLocationSetup(null);
    api.locationsList(currentAccount.id)
      .then(({ locations }) => setNeedsLocationSetup(locations.length === 0))
      .catch(() => setNeedsLocationSetup(false)); // fail open — don't block on network error
  }, [signedIn, currentAccount?.id]);

  if (loading || needsLocationSetup === null) {
    return (
      <div className="min-h-screen bg-paper grid place-items-center text-ink/50 text-sm">
        Loading…
      </div>
    );
  }
  if (!signedIn) return <Navigate to="/login" replace />;

  if (needsLocationSetup && currentAccount) {
    return (
      <div className="min-h-screen bg-paper">
        <CreateLocationModal
          accountId={currentAccount.id}
          mode="current-account"
          forced
          onClose={() => {}}
          onCreated={async (accountId) => {
            await refreshMe();
            setCurrentAccount(accountId);
            setNeedsLocationSetup(false);
          }}
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-paper flex">
      <AppSidebar />
      <div className="flex-1 min-w-0 flex flex-col">
        <AppTopBar />
        <main className="flex-1 px-4 sm:px-6 lg:px-10 py-6 sm:py-10 max-w-[1400px] w-full mx-auto">
          {/* WhatsApp-connect and Slack-identity nudge banners used to live
              here. Removed: they called api.phoneAdd()/api.slackUpdate(),
              neither of which the gateway implements (no /phones or
              /auth/me/slack routes — see api.ts's doc comments), so they
              could never succeed and would have nagged on every page load
              forever. Reinstate once those routes exist server-side. */}
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
    <header className="mb-8 sm:mb-10 pb-6 sm:pb-8 border-b border-ink/10 flex flex-wrap items-end gap-x-6 gap-y-3 sm:gap-x-8 sm:gap-y-4 justify-between">
      <div className="min-w-0">
        {kicker && (
          <span className="inline-flex items-center gap-2 text-[10px] sm:text-[11px] uppercase tracking-[0.22em] text-ink/55">
            <span className="h-1 w-1 rounded-full bg-terracotta" aria-hidden />
            {kicker}
          </span>
        )}
        <h1 className="font-display-tight text-3xl sm:text-4xl lg:text-[40px] leading-[1.02] tracking-[-0.02em] mt-2">
          {title}
        </h1>
        {description && (
          <p className="mt-3 text-sm sm:text-[15px] text-ink/65 max-w-xl leading-relaxed">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex flex-wrap gap-2 self-end">{actions}</div>}
    </header>
  );
}
