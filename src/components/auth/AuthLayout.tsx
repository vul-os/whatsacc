import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArchMark } from '@/components/illustrations/ArchMark';
import { AuthAside } from '@/components/illustrations/AuthAside';

// Shared two-column shell for /login, /signup, /forgot-password,
// /reset-password and similar. Aside on the left (top on mobile).
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
    <div className="min-h-screen lg:h-screen lg:overflow-hidden bg-paper grid grid-cols-1 lg:grid-cols-12">
      <aside
        className={[
          'lg:col-span-5 bg-ink text-paper relative overflow-hidden',
          asideOrder === 'last' ? 'lg:order-last' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <div className="absolute inset-0 grain pointer-events-none" />
        <AuthAside className="absolute inset-0 h-full w-full opacity-80" />

        {/* corner architectural ticks — quiet structural detail */}
        <span className="hidden lg:block absolute top-6 left-6 h-3 w-3 border-l border-t border-paper/30" aria-hidden />
        <span className="hidden lg:block absolute top-6 right-6 h-3 w-3 border-r border-t border-paper/30" aria-hidden />
        <span className="hidden lg:block absolute bottom-6 left-6 h-3 w-3 border-l border-b border-paper/30" aria-hidden />
        <span className="hidden lg:block absolute bottom-6 right-6 h-3 w-3 border-r border-b border-paper/30" aria-hidden />

        <div className="relative h-full min-h-[260px] lg:min-h-0 flex flex-col p-6 sm:p-10 lg:p-12">
          <Link to="/" className="inline-flex items-center gap-2.5 group">
            <ArchMark className="h-7 w-7 sm:h-8 sm:w-8 text-paper transition-transform group-hover:-translate-y-0.5" />
            <span className="font-display italic text-lg sm:text-xl">whatsacc</span>
          </Link>

          <div className="mt-auto pt-10 sm:pt-16">
            <span className="inline-flex items-center gap-2 text-[10px] sm:text-[11px] uppercase tracking-[0.22em] text-paper/55 mb-4 sm:mb-5">
              <span className="h-1 w-1 rounded-full bg-terracotta-soft" aria-hidden />
              {asideKicker}
            </span>
            <p className="font-display-tight text-3xl sm:text-4xl lg:text-[44px] leading-[0.96] tracking-[-0.02em] max-w-md text-paper">
              {asideTitle}
            </p>
            {asideBody && (
              <div className="mt-5 sm:mt-6 text-paper/65 max-w-md leading-relaxed text-sm sm:text-[15px]">
                {asideBody}
              </div>
            )}
          </div>

          {/* footer signature — quiet, builds trust */}
          <div className="hidden lg:flex items-center justify-between mt-12 pt-6 border-t border-paper/15">
            <span className="text-[10px] uppercase tracking-[0.22em] text-paper/40">
              whatsacc &middot; access by message
            </span>
            <span className="text-[10px] uppercase tracking-[0.22em] text-paper/40">
              made in ZA
            </span>
          </div>
        </div>
      </aside>

      <main className="lg:col-span-7 lg:overflow-y-auto flex items-start lg:items-center justify-center">
        <div className="w-full max-w-[460px] mx-auto px-5 sm:px-8 py-10 sm:py-14 lg:py-12">{children}</div>
      </main>
    </div>
  );
}
