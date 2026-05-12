import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { MobileNavDrawer } from './MobileNavDrawer';
import { CurrencySelector } from './CurrencySelector';
import { AccountSwitcher } from './AccountSwitcher';
import { useTheme } from '@/lib/theme';

export function AppTopBar() {
  const { user } = useAuth();
  const { theme, toggleTheme } = useTheme();
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
            <button
              type="button"
              onClick={toggleTheme}
              className="h-9 w-9 grid place-items-center rounded-full border border-ink/10 bg-paper-cool text-ink/70 hover:text-ink hover:border-ink/25 transition-colors"
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
            >
              {theme === 'dark' ? (
                <svg viewBox="0 0 24 24" className="h-4.5 w-4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" className="h-4.5 w-4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M20.5 14.5A7.5 7.5 0 0 1 9.5 3.5 8.6 8.6 0 1 0 20.5 14.5Z" />
                </svg>
              )}
            </button>
            {user && <AccountSwitcher />}
          </div>
        </div>
      </div>

      <MobileNavDrawer open={mobileOpen} onClose={() => setMobileOpen(false)} />
    </>
  );
}
