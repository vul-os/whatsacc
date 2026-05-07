import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth';

// User-facing pill in the top bar. Drops down to a list of accounts the user
// belongs to so they can switch tenants. If they only belong to one account,
// renders as a non-interactive pill (no dropdown affordance).
export function AccountSwitcher() {
  const { user, accounts, currentAccount, setCurrentAccount } = useAuth();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close on outside click + Escape
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!user) return null;
  const initials = user.name.split(' ').map((s) => s[0] ?? '').join('').slice(0, 2).toUpperCase();
  const onlyOne = accounts.length <= 1;

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => !onlyOne && setOpen((v) => !v)}
        disabled={onlyOne}
        className={`hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full border border-ink/10 transition-colors ${
          onlyOne ? 'cursor-default' : 'hover:border-ink/30 hover:bg-paper-cool'
        }`}
        aria-haspopup={!onlyOne ? 'menu' : undefined}
        aria-expanded={!onlyOne ? open : undefined}
      >
        <span className="grid h-7 w-7 place-items-center rounded-full bg-ink text-paper text-[11px] font-medium">
          {initials || '·'}
        </span>
        <span className="flex flex-col items-start leading-tight">
          <span className="text-[10px] uppercase tracking-[0.18em] text-ink/45">
            {currentAccount?.role ?? '—'}
          </span>
          <span className="text-sm text-ink max-w-[140px] truncate">
            {currentAccount?.name ?? user.name.split(' ')[0]}
          </span>
        </span>
        {!onlyOne && (
          <svg viewBox="0 0 12 8" className="h-2.5 w-2.5 text-ink/55 ml-0.5" aria-hidden>
            <path d="M1 1l5 5 5-5" stroke="currentColor" strokeWidth="1.5" fill="none" />
          </svg>
        )}
      </button>

      {open && !onlyOne && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-72 rounded-2xl border border-ink/10 bg-paper shadow-[0_24px_48px_-24px_rgba(26,31,54,0.25)] py-2 z-30"
        >
          <p className="px-4 py-2 text-[10px] uppercase tracking-[0.22em] text-ink/45">
            Your locations
          </p>
          <ul>
            {accounts.map((a) => {
              const isActive = currentAccount?.id === a.id;
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={isActive}
                    onClick={() => {
                      setCurrentAccount(a.id);
                      setOpen(false);
                    }}
                    className={`w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-paper-cool transition-colors ${
                      isActive ? 'bg-paper-cool' : ''
                    }`}
                  >
                    <span
                      className={`flex-none h-8 w-8 rounded-lg grid place-items-center text-[11px] font-medium ${
                        a.billing_type === 'business'
                          ? 'bg-terracotta/15 text-terracotta-deep'
                          : 'bg-moss/15 text-moss'
                      }`}
                      aria-hidden
                    >
                      {a.name.split(' ').map((s) => s[0]).join('').slice(0, 2).toUpperCase() || '·'}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm text-ink truncate">{a.name}</span>
                      <span className="block text-[10px] uppercase tracking-[0.18em] text-ink/50 mt-0.5">
                        {a.role} · {a.billing_type}
                      </span>
                    </span>
                    {isActive && (
                      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-terracotta" aria-hidden>
                        <path d="M3 8l3 3 7-7" stroke="currentColor" strokeWidth="2" fill="none" />
                      </svg>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="border-t border-ink/8 mt-1 pt-2 px-2">
            <p className="px-2 py-1 text-xs text-ink/55">
              Signed in as <span className="text-ink">{user.email}</span>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
