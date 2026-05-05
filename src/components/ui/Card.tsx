import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Tone = 'paper' | 'ink' | 'cream' | 'transparent';

const tones: Record<Tone, string> = {
  paper: 'bg-paper-cool border border-ink/8 text-ink',
  ink: 'bg-ink text-paper border border-ink/0',
  cream: 'bg-paper-warm border border-ink/8 text-ink',
  transparent: 'bg-transparent text-ink',
};

export function Card({
  tone = 'paper',
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'relative rounded-3xl p-6 shadow-[0_1px_0_rgba(26,31,54,0.04),0_12px_32px_-16px_rgba(26,31,54,0.18)]',
        tones[tone],
        className,
      )}
    >
      {children}
    </div>
  );
}

export function StatBlock({
  label,
  value,
  hint,
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <span className="text-[11px] uppercase tracking-[0.18em] text-ink/55">{label}</span>
      <span className="font-display text-3xl text-ink leading-none">{value}</span>
      {hint && <span className="text-sm text-ink/60">{hint}</span>}
    </div>
  );
}
