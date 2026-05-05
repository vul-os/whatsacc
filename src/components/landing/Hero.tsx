import { LinkButton } from '@/components/ui/Button';
import { HeroPortal } from '@/components/illustrations/HeroPortal';

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="mx-auto max-w-[1280px] px-5 sm:px-6 lg:px-10 pt-6 pb-16 sm:pt-10 sm:pb-20 lg:pt-14 lg:pb-28 grid grid-cols-12 gap-x-8 gap-y-12 lg:items-end">
        <div className="col-span-12 lg:col-span-7 relative z-10 order-2 lg:order-1">
          <div className="flex items-center gap-3 mb-6 sm:mb-8">
            <span className="h-px w-8 sm:w-10 bg-ink/40" />
            <span className="text-[10px] sm:text-[11px] uppercase tracking-[0.22em] text-ink/55">
              what&rsquo;s access &middot; est. 2026
            </span>
          </div>

          <h1
            className="font-display-tight leading-[0.92] text-ink"
            style={{ fontSize: 'clamp(2.75rem, 11.5vw, 8rem)' }}
          >
            Texts
            <br />
            that{' '}
            <em
              className="italic text-terracotta"
              style={{ fontVariationSettings: '"SOFT" 100' }}
            >
              open
            </em>
            <br />
            <span className="relative inline-block">
              gates.
              <svg
                className="pointer-events-none absolute left-0 right-0 -bottom-2 sm:-bottom-3 w-full h-2.5 sm:h-3"
                viewBox="0 0 360 12"
                preserveAspectRatio="none"
                aria-hidden
              >
                <path
                  d="M4 8 Q 92 -2 180 6 T 356 4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </span>
          </h1>

          <p className="mt-8 sm:mt-10 max-w-md text-base sm:text-lg text-ink/70 leading-relaxed">
            whatsacc lets residents, staff and visitors open a gate, door or barrier with a
            single WhatsApp message. No app, no remote, no fob to lose.
          </p>

          <div className="mt-7 sm:mt-8 flex flex-wrap items-center gap-3">
            <LinkButton to="/signup" variant="ink" size="lg">
              Start free
            </LinkButton>
            <LinkButton to="/docs" variant="ghost" size="lg">
              <span>How it works</span>
              <svg className="ml-1 h-4 w-4" viewBox="0 0 16 16" aria-hidden>
                <path
                  d="M3 8h10M9 4l4 4-4 4"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </LinkButton>
          </div>

          <dl className="mt-12 sm:mt-14 grid grid-cols-3 gap-4 sm:gap-6 max-w-md border-t border-ink/15 pt-5 sm:pt-6">
            <div>
              <dt className="text-[10px] sm:text-[11px] uppercase tracking-[0.18em] text-ink/45">Avg open</dt>
              <dd className="font-display text-xl sm:text-2xl mt-1">1.8s</dd>
            </div>
            <div>
              <dt className="text-[10px] sm:text-[11px] uppercase tracking-[0.18em] text-ink/45">Locations</dt>
              <dd className="font-display text-xl sm:text-2xl mt-1">412</dd>
            </div>
            <div>
              <dt className="text-[10px] sm:text-[11px] uppercase tracking-[0.18em] text-ink/45">Uptime</dt>
              <dd className="font-display text-xl sm:text-2xl mt-1">99.98%</dd>
            </div>
          </dl>
        </div>

        <div className="col-span-12 lg:col-span-5 order-1 lg:order-2 relative">
          <div className="relative drift mx-auto max-w-[360px] sm:max-w-[420px] lg:max-w-[480px]">
            <HeroPortal className="block w-full h-auto" />
            {/* corner ticks anchor the portal on desktop */}
            <span className="hidden lg:block absolute -left-3 -top-3 h-4 w-4 border-l-2 border-t-2 border-ink/40" />
            <span className="hidden lg:block absolute -right-3 -bottom-3 h-4 w-4 border-r-2 border-b-2 border-ink/40" />
          </div>
        </div>
      </div>

      {/* editorial date strip */}
      <div className="border-y border-ink/10 bg-paper-warm/50">
        <div className="mx-auto max-w-[1280px] px-5 sm:px-6 lg:px-10 py-3 flex items-center justify-between gap-4 text-[10px] sm:text-[11px] uppercase tracking-[0.22em] text-ink/55">
          <span className="shrink-0">Vol. 01 &mdash; Issue 04</span>
          <span className="hidden md:inline">&mdash; a quiet revolution at the threshold &mdash;</span>
          <span className="shrink-0 text-right">Cape Town &middot; Lagos &middot; Lisbon</span>
        </div>
      </div>
    </section>
  );
}
