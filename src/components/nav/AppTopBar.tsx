import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { MobileNavDrawer } from './MobileNavDrawer';
import { CurrencySelector } from './CurrencySelector';
import { AccountSwitcher } from './AccountSwitcher';

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

          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            <CurrencySelector className="hidden sm:inline-block" />

            <Link
              to="/app/open"
              className="group/open relative flex items-center gap-2 sm:gap-2.5 pl-3 pr-4 sm:pr-5 h-9 sm:h-10 rounded-full bg-terracotta text-paper hover:bg-terracotta-deep transition-[background,transform] hover:translate-y-[-1px] shadow-[0_8px_22px_-12px_rgba(214,98,77,0.7)]"
              aria-label="Open gate"
            >
              <span className="relative grid place-items-center h-5 w-5 sm:h-6 sm:w-6">
                <span className="absolute inset-0 rounded-full bg-paper/20 signal-wave" />
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 sm:h-4 sm:w-4">
                  <path
                    d="M6 20 V12 a6 6 0 0 1 12 0 V20 H15 V12 a3 3 0 0 0 -6 0 V20 Z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinejoin="round"
                  />
                  <circle cx="12" cy="16" r="1.4" fill="currentColor" />
                </svg>
              </span>
              <span className="text-sm font-medium tracking-tight">Open</span>
              <span className="hidden sm:inline text-sm font-medium tracking-tight">gate</span>
            </Link>

            {user && <AccountSwitcher />}
          </div>
        </div>
      </div>

      <MobileNavDrawer open={mobileOpen} onClose={() => setMobileOpen(false)} />
    </>
  );
}
