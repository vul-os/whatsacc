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
        {/* texture only — artwork sits inline below in its own row */}
        <div className="absolute inset-0 grain pointer-events-none" />

        {/* Three flex rows: logo at top, artwork takes the middle (flex-1 so
            it grabs all remaining vertical space), text at the bottom. They
            are siblings — the artwork physically cannot overlap either text
            block. */}
        <div className="relative z-10 h-full flex flex-col p-6 sm:p-10">
          <Link to="/" className="inline-flex items-center gap-2.5 shrink-0">
            <ArchMark className="h-7 w-7 sm:h-8 sm:w-8 text-paper" />
            <span className="font-display italic text-lg sm:text-xl">whatsacc</span>
          </Link>

          {/* Artwork row — takes all the space between logo and text. The SVG
              fills the row using its natural aspect, capped so it doesn't
              get absurdly large on huge monitors. Hidden on the very narrow
              mobile aside where it would crowd the text. */}
          <div className="hidden sm:flex flex-1 items-center justify-center min-h-0 py-4 lg:py-6">
            <AuthAside className="w-full h-full max-w-[440px] max-h-[440px] opacity-95" />
          </div>

          {/* Bottom text row */}
          <div className="shrink-0 mt-6 sm:mt-0">
            <p className="text-[10px] sm:text-[11px] uppercase tracking-[0.22em] text-paper/55 mb-2 sm:mb-3">
              {asideKicker}
            </p>
            <p className="font-display-tight text-3xl sm:text-4xl lg:text-5xl leading-[0.95] max-w-md">
              {asideTitle}
            </p>
            {asideBody && (
              <div className="mt-3 sm:mt-5 text-paper/65 max-w-md leading-relaxed text-sm sm:text-base">
                {asideBody}
              </div>
            )}
          </div>
        </div>
      </aside>

      <main className="lg:col-span-7 lg:overflow-y-auto flex items-start lg:items-center justify-center">
        <div className="w-full max-w-md mx-auto px-5 sm:px-6 py-10 sm:py-14">{children}</div>
      </main>
    </div>
  );
}
