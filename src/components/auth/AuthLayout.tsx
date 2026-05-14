import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArchMark } from '@/components/illustrations/ArchMark';
import { AuthScene } from '@/components/illustrations/AuthScene';
import { ThemeToggle } from '@/components/nav/ThemeToggle';

// Two-column shell for /login, /signup, /forgot-password, /reset-password.
// Aside is the editorial counterweight — kept dark in both modes via the
// --aside-surface token so the night-time vibe survives a theme flip.
export function AuthLayout({
  asideKicker,
  asideTitle,
  asideBody,
  asideOrder = 'first',
  children,
}: {
  asideKicker: string;
  asideTitle: string;
  asideBody?: ReactNode;
  asideOrder?: 'first' | 'last';
  children: ReactNode;
}) {
  return (
    <div className="relative z-10 min-h-screen lg:h-screen lg:overflow-hidden grid grid-cols-1 lg:grid-cols-12">
      <aside
        className={[
          'auth-aside lg:col-span-5 relative overflow-hidden isolate',
          asideOrder === 'last' ? 'lg:order-last' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <AuthScene className="absolute inset-0 h-full w-full" />
        {/* readable bottom — gradient lifts kicker/title off the illustration */}
        <div
          className="auth-aside-fade absolute inset-x-0 bottom-0 h-2/3 pointer-events-none"
          aria-hidden
        />
        <div className="absolute inset-0 grain pointer-events-none opacity-40" aria-hidden />

        {/* corner architectural ticks — quiet structural detail */}
        <span className="hidden lg:block absolute top-6 left-6 h-3 w-3 border-l border-t border-current/40 z-10" aria-hidden />
        <span className="hidden lg:block absolute top-6 right-6 h-3 w-3 border-r border-t border-current/40 z-10" aria-hidden />
        <span className="hidden lg:block absolute bottom-6 left-6 h-3 w-3 border-l border-b border-current/40 z-10" aria-hidden />
        <span className="hidden lg:block absolute bottom-6 right-6 h-3 w-3 border-r border-b border-current/40 z-10" aria-hidden />

        <div className="relative z-10 h-full min-h-[320px] lg:min-h-0 flex flex-col p-6 sm:p-10 lg:p-12">
          <Link to="/" className="inline-flex items-center gap-2.5 group w-fit">
            <ArchMark className="h-7 w-7 sm:h-8 sm:w-8 transition-transform group-hover:-translate-y-0.5" />
            <span className="font-display italic text-lg sm:text-xl">whatsacc</span>
          </Link>

          <div className="mt-auto pt-10 sm:pt-16">
            <span className="inline-flex items-center gap-2 text-[10px] sm:text-[11px] uppercase tracking-[0.22em] text-current/55 mb-4 sm:mb-5">
              <span className="h-1 w-1 rounded-full bg-terracotta-soft" aria-hidden />
              {asideKicker}
            </span>
            <p className="font-display-tight text-3xl sm:text-4xl lg:text-[44px] leading-[0.96] tracking-[-0.02em] max-w-md">
              {asideTitle}
            </p>
            {asideBody && (
              <div className="mt-5 sm:mt-6 text-current/65 max-w-md leading-relaxed text-sm sm:text-[15px]">
                {asideBody}
              </div>
            )}
          </div>

          {/* footer signature */}
          <div className="hidden lg:flex items-center justify-between mt-12 pt-6 border-t border-current/15">
            <span className="text-[10px] uppercase tracking-[0.22em] text-current/40">
              whatsacc &middot; access by message
            </span>
            <span className="text-[10px] uppercase tracking-[0.22em] text-current/40">
              made in ZA
            </span>
          </div>
        </div>
      </aside>

      <main className="lg:col-span-7 lg:overflow-y-auto flex items-start lg:items-center justify-center relative">
        <div className="absolute top-4 right-4 sm:top-5 sm:right-6 z-10">
          <ThemeToggle variant="auth" />
        </div>
        <div className="w-full max-w-[460px] mx-auto px-5 sm:px-8 py-10 sm:py-14 lg:py-12">
          {children}
        </div>
      </main>
    </div>
  );
}
