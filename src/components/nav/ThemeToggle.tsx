import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/cn';

/**
 * Animated sun ↔ moon theme toggle.
 *
 * Variants:
 *   default  — app shell top-bar: compact, corporate, border pill
 *   landing  — marketing nav: same pill + warm aura glow on hover
 *   auth     — form panel corner: ghost, no border, minimal footprint
 */
type ToggleVariant = 'default' | 'landing' | 'auth';

const variantClasses: Record<ToggleVariant, string> = {
  default:
    'h-9 w-9 rounded-full border border-ink/10 bg-paper-cool text-ink/65 ' +
    'hover:text-ink hover:border-ink/25 hover:bg-paper-warm transition-colors duration-150',
  landing:
    'theme-toggle--landing h-9 w-9 rounded-full border border-ink/10 ' +
    'bg-paper-cool/70 backdrop-blur-sm text-ink/65 ' +
    'hover:text-ink hover:border-ink/30 hover:bg-paper-warm',
  auth:
    'h-8 w-8 rounded-full text-ink/45 hover:text-ink hover:bg-ink/5 ' +
    'transition-colors duration-150',
};

export function ThemeToggle({
  variant = 'default',
  className,
}: {
  variant?: ToggleVariant;
  className?: string;
}) {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className={cn('theme-toggle grid place-items-center', variantClasses[variant], className)}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={isDark ? 'Light mode' : 'Dark mode'}
    >
      {/* both icons stacked; CSS drives which is visible */}
      <span className="theme-toggle-track" aria-hidden>
        {/* Sun — visible in light mode */}
        <svg
          viewBox="0 0 24 24"
          className="theme-toggle-sun"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>

        {/* Moon — visible in dark mode */}
        <svg
          viewBox="0 0 24 24"
          className="theme-toggle-moon"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M20.5 14.5A7.5 7.5 0 0 1 9.5 3.5 8.6 8.6 0 1 0 20.5 14.5Z" />
        </svg>
      </span>
    </button>
  );
}
