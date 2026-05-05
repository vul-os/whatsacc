import { useEffect, useId, useRef, useState } from 'react';
import { CURRENCIES, COUNTRIES, type Currency, type CurrencyCode } from '@/lib/billing/data';
import { useCurrency } from '@/lib/billing/currency';
import { cn } from '@/lib/cn';

// Pick a representative flag for each supported currency. For multi-country
// currencies (EUR), we surface a generic globe rather than picking favourites.
const FLAG_OVERRIDES: Partial<Record<CurrencyCode, string>> = {
  EUR: '🇪🇺',
};

function flagFor(code: CurrencyCode): string {
  if (FLAG_OVERRIDES[code]) return FLAG_OVERRIDES[code]!;
  // Find a country whose primary currency matches.
  const country = COUNTRIES.find((c) => c.currencyCode === code);
  return country?.flag ?? '🌐';
}

type Props = {
  /** Render the trigger as a full-width row (used inside the mobile panel). */
  variant?: 'compact' | 'block';
  className?: string;
};

export function CurrencySelector({ variant = 'compact', className }: Props) {
  const { currency, setCurrency } = useCurrency();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  function pick(c: Currency) {
    setCurrency(c.code);
    setOpen(false);
  }

  return (
    <div
      ref={wrapRef}
      className={cn('relative', variant === 'block' ? 'w-full' : 'inline-block', className)}
    >
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex items-center gap-2 rounded-full border border-ink/10 bg-paper text-sm transition-colors',
          'hover:border-ink/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink',
          variant === 'compact'
            ? 'h-9 px-3'
            : 'w-full justify-between px-4 py-3 text-base',
        )}
      >
        <span className="flex items-center gap-2">
          <span aria-hidden className="text-base leading-none">
            {flagFor(currency.code)}
          </span>
          <span className="font-medium tabular-nums tracking-tight">{currency.code}</span>
        </span>
        <svg
          viewBox="0 0 12 12"
          aria-hidden
          className={cn('h-3 w-3 text-ink/50 transition-transform', open && 'rotate-180')}
        >
          <path d="M2 4.5 L6 8.5 L10 4.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          id={listboxId}
          role="listbox"
          aria-label="Display currency"
          className={cn(
            'absolute z-40 mt-2 w-72 max-h-[70vh] overflow-y-auto rounded-2xl border border-ink/10 bg-paper p-2 shadow-lg',
            // Anchor: right-align in compact (top-bar) variant; left-align as a
            // block (e.g. mobile panel).
            variant === 'compact' ? 'right-0' : 'left-0',
          )}
        >
          <p className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-[0.22em] text-ink/45">
            Display currency
          </p>
          <ul className="flex flex-col">
            {CURRENCIES.map((c) => {
              const selected = c.code === currency.code;
              return (
                <li key={c.code}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => pick(c)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors',
                      selected ? 'bg-paper-warm text-ink' : 'text-ink/80 hover:bg-paper-cool',
                    )}
                  >
                    <span aria-hidden className="text-base leading-none">
                      {flagFor(c.code)}
                    </span>
                    <span className="font-medium tabular-nums tracking-tight">{c.code}</span>
                    <span className="text-ink/45">{c.symbol}</span>
                    <span className="ml-auto truncate text-ink/65">{c.name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
