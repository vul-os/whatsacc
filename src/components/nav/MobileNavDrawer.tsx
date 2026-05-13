import { useEffect } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { ArchMark } from '@/components/illustrations/ArchMark';
import { ThemeToggle } from './ThemeToggle';
import { cn } from '@/lib/cn';
import { APP_NAV_ITEMS } from './items';
import { useAuth } from '@/lib/auth';

export function MobileNavDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { user, signOut } = useAuth();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="lg:hidden fixed inset-0 z-50 flex">
      <button
        type="button"
        aria-label="Close menu"
        onClick={onClose}
        className="absolute inset-0 bg-ink/55 backdrop-blur-sm"
      />
      <aside className="relative w-72 max-w-[85vw] bg-paper-cool border-r border-ink/10 shadow-xl flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-ink/10">
          <Link to="/" onClick={onClose} className="inline-flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-md bg-ink text-paper">
              <ArchMark className="h-5 w-5" />
            </span>
            <span className="font-display italic text-lg">whatsacc</span>
          </Link>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="h-9 w-9 grid place-items-center rounded-full hover:bg-ink/5"
          >
            <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
              <path
                d="M5 5l10 10M15 5L5 15"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto p-3 flex flex-col gap-0.5">
          {APP_NAV_ITEMS.map((it) => (
            <NavLink
              key={it.to}
              to={it.to}
              end={it.end}
              onClick={onClose}
              className={({ isActive }) =>
                cn(
                  'px-3 py-2.5 rounded-lg text-sm transition-colors',
                  isActive
                    ? 'bg-ink text-paper'
                    : 'text-ink/75 hover:bg-ink/5 hover:text-ink',
                )
              }
            >
              {it.label}
            </NavLink>
          ))}
        </nav>

        <div className="p-3 border-t border-ink/10">
          {user && (
            <p className="px-3 py-2 text-xs text-ink/55">
              Signed in as <span className="text-ink/80">{user.email}</span>
            </p>
          )}
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-xs text-ink/50">Display theme</span>
            <ThemeToggle variant="default" />
          </div>
          <button
            type="button"
            onClick={async () => {
              await signOut();
              onClose();
            }}
            className="w-full text-left px-3 py-2.5 rounded-lg text-sm text-ink/65 hover:bg-ink/5 hover:text-terracotta-deep"
          >
            Sign out
          </button>
        </div>
      </aside>
    </div>
  );
}
