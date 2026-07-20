import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArchMark } from '@/components/illustrations/ArchMark';
import { HeroGateDayNightMobile } from '@/components/illustrations/HeroGateDayNightMobile';
import { ThemeToggle } from '@/components/nav/ThemeToggle';

// Two-column shell for /login, /signup, /forgot-password, /reset-password.
// The aside is the brand counterweight and now mirrors the landing hero exactly:
// the same day/night gate scene (open & sunlit by day, drawn shut & locked by
// night) animates on the theme toggle. The panel itself tracks the theme — light
// + open by day, dark + shut by night — so the auth pages read as one world with
// the marketing site. Copy sits up top; the gate is grounded along the bottom.
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
    <div className="relative z-10 min-h-[100svh] lg:h-screen lg:overflow-hidden grid grid-cols-1 lg:grid-cols-12">
      {/* Brand aside with the day/night gate scene — desktop only. On mobile the
          scene is dropped (it crowded the form and forced scrolling); a compact
          logo header in the form column carries the brand instead. */}
      <aside
        className={[
          'hidden lg:block auth-aside lg:col-span-5 relative overflow-hidden isolate lg:min-h-0',
          asideOrder === 'last' ? 'lg:order-last lg:border-l lg:border-r-0' : 'lg:border-r',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {/* ── gate backdrop: open & sunlit by day, shut & locked by night ──
            The exact hero scene + choreography, grounded along the bottom; the
            sky is transparent so the panel colour (which tracks the theme) reads
            as the sky, just like the hero. */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden>
          <HeroGateDayNightMobile className="absolute bottom-0 left-0 w-full h-auto min-h-full object-bottom" />
        </div>

        {/* top scrim — lifts the kicker/title/body off the scene in both themes */}
        <div
          className="auth-aside-fade absolute inset-x-0 top-0 h-2/3 pointer-events-none"
          aria-hidden
        />
        <div className="absolute inset-0 grain pointer-events-none opacity-30" aria-hidden />

        {/* corner architectural ticks — quiet structural detail */}
        <span className="hidden lg:block absolute top-6 left-6 h-3 w-3 border-l border-t border-ink/25 z-10" aria-hidden />
        <span className="hidden lg:block absolute top-6 right-6 h-3 w-3 border-r border-t border-ink/25 z-10" aria-hidden />
        <span className="hidden lg:block absolute bottom-6 left-6 h-3 w-3 border-l border-b border-ink/25 z-10" aria-hidden />
        <span className="hidden lg:block absolute bottom-6 right-6 h-3 w-3 border-r border-b border-ink/25 z-10" aria-hidden />

        <div className="relative z-10 h-full flex flex-col p-6 sm:p-10 lg:p-12">
          <Link to="/" className="inline-flex items-center gap-2.5 group w-fit text-ink">
            <ArchMark className="h-7 w-7 sm:h-8 sm:w-8 transition-transform group-hover:-translate-y-0.5" />
            <span className="font-display italic text-lg sm:text-xl">lintel</span>
          </Link>

          <div className="mt-7 sm:mt-12">
            <span className="inline-flex items-center gap-2 text-[10px] sm:text-[11px] uppercase tracking-[0.22em] text-ink/55 mb-4 sm:mb-5">
              <span className="h-1 w-1 rounded-full bg-terracotta" aria-hidden />
              {asideKicker}
            </span>
            <p className="font-display-tight text-3xl sm:text-4xl lg:text-[44px] leading-[0.96] tracking-[-0.02em] text-ink max-w-md">
              {asideTitle}
            </p>
            {asideBody && (
              <div className="hidden lg:block mt-5 sm:mt-6 text-ink/65 max-w-md leading-relaxed text-sm sm:text-[15px]">
                {asideBody}
              </div>
            )}
          </div>

          {/* footer signature — pinned to the bottom, riding above the gate */}
          <div className="hidden lg:flex items-center justify-between mt-auto pt-6">
            <span className="text-[10px] uppercase tracking-[0.22em] text-ink/40">
              lintel &middot; access by message
            </span>
            <span className="text-[10px] uppercase tracking-[0.22em] text-ink/40">
              made in ZA
            </span>
          </div>
        </div>
      </aside>

      <main className="lg:col-span-7 lg:overflow-y-auto flex flex-col relative">
        {/* top bar — brand mark (mobile only) + theme toggle. On desktop the logo
            lives in the aside, so the bar is taken out of flow (absolute) and only
            the toggle floats top-right — the form then centres in the full column. */}
        <header className="flex items-center justify-between gap-3 px-5 pt-5 sm:px-8 sm:pt-6 lg:absolute lg:inset-x-0 lg:top-0 lg:z-10 lg:px-8 lg:pt-6 lg:justify-end">
          <Link to="/" className="lg:hidden inline-flex items-center gap-2.5 group w-fit text-ink">
            <ArchMark className="h-7 w-7 transition-transform group-hover:-translate-y-0.5" />
            <span className="font-display italic text-lg">lintel</span>
          </Link>
          <ThemeToggle variant="auth" />
        </header>

        <div className="flex-1 flex items-center justify-center">
          <div className="w-full max-w-[420px] mx-auto px-5 sm:px-8 py-6 sm:py-8 lg:py-8">
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
