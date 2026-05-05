import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'ink' | 'ghost' | 'outline' | 'paper';
type Size = 'sm' | 'md' | 'lg';

type CommonProps = {
  variant?: Variant;
  size?: Size;
  className?: string;
  children: ReactNode;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
};

const base =
  'group/btn relative inline-flex items-center justify-center gap-2 font-medium tracking-tight transition-[transform,background-color,color,box-shadow] duration-200 ease-out will-change-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-paper focus-visible:ring-ink disabled:opacity-50 disabled:pointer-events-none';

const sizes: Record<Size, string> = {
  sm: 'h-9 px-4 text-sm rounded-full',
  md: 'h-11 px-5 text-[15px] rounded-full',
  lg: 'h-14 px-7 text-base rounded-full',
};

const variants: Record<Variant, string> = {
  primary:
    'bg-terracotta text-paper hover:bg-terracotta-deep shadow-[0_1px_0_rgba(0,0,0,0.08),0_8px_24px_-12px_rgba(214,98,77,0.55)] hover:translate-y-[-1px]',
  ink: 'bg-ink text-paper hover:bg-ink-soft shadow-[0_1px_0_rgba(0,0,0,0.1),0_10px_28px_-14px_rgba(26,31,54,0.6)] hover:translate-y-[-1px]',
  paper: 'bg-paper text-ink hover:bg-paper-cool border border-ink/10',
  outline:
    'bg-transparent text-ink border border-ink/25 hover:border-ink hover:bg-ink hover:text-paper',
  ghost: 'bg-transparent text-ink hover:bg-ink/5',
};

export const Button = forwardRef<
  HTMLButtonElement,
  CommonProps & ButtonHTMLAttributes<HTMLButtonElement>
>(function Button(
  { variant = 'primary', size = 'md', className, children, iconLeft, iconRight, ...rest },
  ref,
) {
  return (
    <button ref={ref} className={cn(base, sizes[size], variants[variant], className)} {...rest}>
      {iconLeft}
      <span>{children}</span>
      {iconRight}
    </button>
  );
});

export function LinkButton({
  to,
  variant = 'primary',
  size = 'md',
  className,
  children,
  iconLeft,
  iconRight,
}: CommonProps & { to: string }) {
  return (
    <Link to={to} className={cn(base, sizes[size], variants[variant], className)}>
      {iconLeft}
      <span>{children}</span>
      {iconRight}
    </Link>
  );
}
