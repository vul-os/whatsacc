import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { MobileNavDrawer } from './MobileNavDrawer';
import { CurrencySelector } from './CurrencySelector';
import { AccountSwitcher } from './AccountSwitcher';
import { ThemeToggle } from './ThemeToggle';

export function AppTopBar() {
  const { user } = useAuth();
  const loc = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const segs = loc.pathname.split('/').filter(Boolean);
  const last = segs[segs.length - 1] ?? 'app';
  const title = last === 'app' ? 'Dashboard' : last.replace(/-/g, ' ');

  return (
    <>
      <div className="sticky top-0 z-20 bg-paper/85 backdrop-blur border-b border-ink/10">
        <div className="flex items-center gap-3 sm:gap-4 px-4 sm:px-6 lg:px-10 h-14 sm:h-16">
          <button
            type="button"
            aria-label="Open menu"
            onClick={() => setMobileOpen(true)}
            className="lg:hidden h-9 w-9 grid place-items-center rounded-full hover:bg-ink/5 -ml-1"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
              <path
                d="M4 7h16M4 12h16M4 17h16"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>

          <div className="flex items-baseline gap-2 sm:gap-3 min-w-0">
            <span className="hidden sm:inline text-[11px] uppercase tracking-[0.18em] text-ink/45">
              whatsacc
            </span>
            <span className="hidden sm:inline text-ink/30">/</span>
            <span className="font-display text-lg sm:text-xl capitalize truncate">{title}</span>
          </div>

          {/*
            No global "open gate" CTA here — it was ambiguous (which gate?).
            Per-AP quick-action buttons live on the dashboard, and each AP has
            its own detail page at /app/access-points/:id.
          */}
          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            <CurrencySelector className="hidden sm:inline-block" />
            <ThemeToggle variant="default" />
            {user && <AccountSwitcher />}
          </div>
        </div>
      </div>

      <MobileNavDrawer open={mobileOpen} onClose={() => setMobileOpen(false)} />
    </>
  );
}
