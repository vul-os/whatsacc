import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Item = { q: string; a: ReactNode };

export function Accordion({ items, className }: { items: Item[]; className?: string }) {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <ul className={cn('divide-y divide-ink/10 border-y border-ink/10', className)}>
      {items.map((it, i) => {
        const isOpen = open === i;
        return (
          <li key={i}>
            <button
              onClick={() => setOpen(isOpen ? null : i)}
              aria-expanded={isOpen}
              className="group/q flex w-full items-start gap-4 sm:gap-6 py-5 sm:py-6 text-left"
            >
              <span className="numeral text-[11px] sm:text-xs text-ink/40 tabular-nums tracking-widest pt-2 sm:pt-2.5 w-6 shrink-0">
                {String(i + 1).padStart(2, '0')}
              </span>
              <span className="font-display text-xl sm:text-2xl md:text-3xl flex-1 leading-snug">
                {it.q}
              </span>
              {/* line accent — hidden on small screens to keep the row clean */}
              <span
                aria-hidden
                className={cn(
                  'hidden md:inline-block mt-3.5 h-px bg-ink shrink-0 transition-[width] duration-300',
                  isOpen ? 'w-12' : 'w-6 group-hover/q:w-9',
                )}
              />
              <span
                aria-hidden
                className={cn(
                  'mt-2 h-4 w-4 shrink-0 transition-transform duration-300 text-ink/70',
                  isOpen ? 'rotate-45' : 'rotate-0',
                )}
              >
                <svg viewBox="0 0 16 16" className="h-full w-full">
                  <path
                    d="M8 1v14M1 8h14"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
            </button>
            <div
              className={cn(
                'grid overflow-hidden transition-[grid-template-rows] duration-300',
                isOpen ? 'grid-rows-[1fr] pb-5 sm:pb-6' : 'grid-rows-[0fr]',
              )}
            >
              <div className="min-h-0">
                <div className="pl-10 sm:pl-12 pr-2 sm:pr-12 max-w-2xl text-ink/75 leading-relaxed">
                  {it.a}
                </div>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
