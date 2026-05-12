import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { ArchMark } from '@/components/illustrations/ArchMark';
import { LinkButton } from '@/components/ui/Button';
import { CurrencySelector } from '@/components/nav/CurrencySelector';
import { cn } from '@/lib/cn';
import { useAuth } from '@/lib/auth';
import { useTheme } from '@/lib/theme';

const links = [
  { to: '/pricing', label: 'Pricing' },
  { to: '/security', label: 'Security' },
  { to: '/docs', label: 'Docs' },
];

export function TopNav() {
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const { signedIn } = useAuth();
  const { theme, toggleTheme } = useTheme();

  // close menu on route change
  useEffect(() => {
    setOpen(false);
  }, [loc.pathname]);

  // lock scroll while panel is open
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <header
      className={cn(
        'sticky top-0 z-30 transition-colors',
        open ? 'bg-paper' : 'bg-paper/85 backdrop-blur',
      )}
    >
      <div className="mx-auto max-w-[1280px] px-5 sm:px-6 lg:px-10 py-4 sm:py-5 flex items-center justify-between gap-4">
        <Link to="/" className="flex items-center gap-2.5 shrink-0" aria-label="whatsacc home">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-ink">
            <ArchMark className="h-5 w-5 text-paper" />
          </span>
          <span className="font-display italic text-xl tracking-tight">whatsacc</span>
        </Link>

        <nav className="hidden md:flex items-center gap-1">
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              className={({ isActive }) =>
                cn(
                  'px-3.5 py-2 text-sm rounded-full transition-colors',
                  isActive ? 'text-ink' : 'text-ink/60 hover:text-ink',
                )
              }
            >
              {l.label}
            </NavLink>
          ))}
          <NavLink
            to={signedIn ? '/app' : '/login'}
            className={({ isActive }) =>
              cn(
                'px-3.5 py-2 text-sm rounded-full transition-colors',
                isActive ? 'text-ink' : 'text-ink/60 hover:text-ink',
              )
            }
          >
            {signedIn ? 'Dashboard' : 'Login'}
          </NavLink>
        </nav>

        <div className="flex items-center gap-1 sm:gap-2">
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
          <CurrencySelector className="hidden sm:inline-block" />
          <LinkButton
            to={signedIn ? '/app' : '/signup'}
            variant="ink"
            size="sm"
            className="hidden sm:inline-flex"
          >
            {signedIn ? 'Go to dashboard' : 'Get started'}
          </LinkButton>
          <button
            type="button"
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="md:hidden grid h-10 w-10 place-items-center rounded-full text-ink/80 hover:bg-ink/5"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
              {open ? (
                <path
                  d="M5 5 L19 19 M19 5 L5 19"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              ) : (
                <path
                  d="M4 8 H20 M4 16 H20"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              )}
            </svg>
          </button>
        </div>
      </div>

      {/* mobile panel — slides in below sticky header */}
      <div
        className={cn(
          'md:hidden fixed inset-x-0 bottom-0 top-[72px] z-20 bg-paper transition-opacity duration-200',
          open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none',
        )}
        aria-hidden={!open}
      >
        <div className="px-5 pt-4 pb-10 flex flex-col h-full">
          <ul className="flex flex-col">
            {links.map((l) => (
              <li key={l.to} className="border-b border-ink/10">
                <NavLink
                  to={l.to}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center justify-between py-4 font-display text-2xl',
                      isActive ? 'text-ink' : 'text-ink/80',
                    )
                  }
                >
                  <span>{l.label}</span>
                  <span aria-hidden className="text-terracotta">
                    &rarr;
                  </span>
                </NavLink>
              </li>
            ))}
            <li className="border-b border-ink/10">
              <Link
                to={signedIn ? '/app' : '/login'}
                className="flex items-center justify-between py-4 font-display text-2xl text-ink/80"
              >
                <span>{signedIn ? 'Dashboard' : 'Login'}</span>
                <span aria-hidden className="text-terracotta">&rarr;</span>
              </Link>
            </li>
          </ul>

          <div className="mt-8">
            <p className="mb-2 text-[11px] uppercase tracking-[0.22em] text-ink/45">
              Display currency
            </p>
            <CurrencySelector variant="block" />
          </div>

          <div className="mt-6">
            <LinkButton to={signedIn ? '/app' : '/signup'} variant="ink" size="lg" className="w-full">
              {signedIn ? 'Go to dashboard' : 'Get started'}
            </LinkButton>
          </div>

          <p className="mt-auto pt-10 text-[11px] uppercase tracking-[0.22em] text-ink/45">
            texts that open gates
          </p>
        </div>
      </div>
    </header>
  );
}
