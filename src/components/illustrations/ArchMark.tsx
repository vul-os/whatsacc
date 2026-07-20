import type { SVGProps } from 'react';
import { cn } from '@/lib/cn';

type ArchMarkProps = SVGProps<SVGSVGElement> & {
  /** Optional class for the terracotta accent dot. Defaults to text-terracotta. */
  dotClassName?: string;
  /** Optional class for the arch stroke. Defaults to currentColor (controlled by `text-*`). */
  strokeClassName?: string;
};

/**
 * Brand mark — a cream arch on navy with a terracotta keystone dot.
 * The stroke follows currentColor (set with text-*), the dot is its own
 * coloured layer so the terracotta accent is preserved on every surface
 * (matches the favicon: navy field, cream arch, terracotta dot).
 */
export function ArchMark({
  className,
  dotClassName,
  strokeClassName,
  ...rest
}: ArchMarkProps) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      {...rest}
    >
      <path
        d="M16 50 V32 a16 16 0 0 1 32 0 V50 H40 V32 a8 8 0 0 0 -16 0 V50 Z"
        stroke="currentColor"
        className={strokeClassName}
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle
        cx="32"
        cy="42"
        r="2.4"
        className={cn('fill-terracotta', dotClassName)}
      />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={className}>
      <em className="font-display not-italic [font-style:italic] tracking-tight">lintel</em>
    </span>
  );
}
