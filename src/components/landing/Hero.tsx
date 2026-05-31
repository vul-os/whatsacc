import { LinkButton } from '@/components/ui/Button';
import { HeroGateDayNight } from '@/components/illustrations/HeroGateDayNight';
import { HeroGateDayNightMobile } from '@/components/illustrations/HeroGateDayNightMobile';

// Hardware brands that the controllers integrate with — used as a quiet
// trust band below the fold. Stays restrained: small caps, ink/45 colour,
// no logo files (just wordmarks) so the page feels owned-and-considered
// rather than like a partnerships salad.
const integrations = ['Centurion', 'BFT', 'Came', 'Nice', 'Et Blue'];

const capabilities = [
  'WhatsApp-native',
  'End-to-end encrypted',
  'Geofence-aware',
  'Audit log per open',
];

export function Hero() {
  return (
    // The hero fills the first viewport minus the sticky nav. On DESKTOP it's a
    // two-column grid (copy + portrait gate), vertically centred, so the trust
    // band lands just below the fold. On MOBILE the gate becomes a full-height
    // atmospheric backdrop (set back at the bottom, sky transparent = page) and
    // the copy sits on top — no cramped band, and the day/night swap reads as
    // the whole scene changing behind the words.
    <section className="relative overflow-hidden">
      <div className="relative mx-auto w-full max-w-[1280px] px-5 sm:px-6 lg:px-10 pt-6 pb-0 sm:pt-8 sm:pb-10 lg:pt-10 lg:pb-12 grid grid-cols-1 lg:grid-cols-12 gap-y-5 lg:gap-x-8 lg:gap-y-0 lg:items-center lg:content-center min-h-[calc(100svh-72px)] lg:min-h-[calc(100svh-64px)]">
        {/* ── mobile backdrop: the gate, set back, behind the copy ──────
            The gate sits full-size at the bottom; a soft page-coloured scrim
            fades down over its top third so the copy always reads crisply over
            the scene (in both themes) without dimming the gate or sun itself. */}
        <div className="hero-mobile-scene lg:hidden absolute inset-0 overflow-hidden pointer-events-none" aria-hidden>
          <HeroGateDayNightMobile className="absolute bottom-0 left-0 w-full h-auto" />
          <div className="absolute inset-x-0 top-0 h-[62%] bg-gradient-to-b from-paper from-35% via-paper/70 via-[68%] to-transparent transition-[background-image] duration-[400ms] ease-out" />
        </div>

        {/* ── left: copy + ctas + capabilities ───────────────────────── */}
        <div className="col-span-12 lg:col-span-7 min-w-0 relative z-10 order-1 lg:order-1">
          {/* eyebrow — small, calm, capability-first */}
          <div className="inline-flex items-center gap-2.5 rounded-full bg-paper-cool border border-ink/10 pl-2.5 pr-4 py-1.5">
            <span className="grid place-items-center h-5 w-5 rounded-full bg-ink text-paper text-[10px] leading-none">
              w
            </span>
            <span className="text-[11px] tracking-[0.18em] uppercase text-ink/65">
              Access, by message
            </span>
          </div>

          {/* headline — capped smaller so the section fits in one viewport */}
          <h1
            className="font-display-tight mt-3 sm:mt-6 leading-[0.94] tracking-[-0.02em] text-ink"
            style={{ fontSize: 'clamp(1.875rem, 7vw, 5rem)' }}
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
                className="pointer-events-none absolute left-0 right-0 -bottom-1.5 sm:-bottom-2 w-full h-2 text-terracotta"
                viewBox="0 0 360 12"
                preserveAspectRatio="none"
                aria-hidden
              >
                <path
                  d="M4 7 Q 92 -1 180 5 T 356 4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </span>
          </h1>

          {/* dek — kept brief so we don't blow the fold */}
          <p className="mt-3 sm:mt-6 max-w-xl text-[15px] sm:text-[17px] leading-snug sm:leading-relaxed text-ink/70">
            Residents, staff and visitors open a gate, door or barrier with one WhatsApp
            message. Phone-verified, geofence-aware, audited end-to-end.
          </p>

          {/* capability chips — hidden on phones to keep the fold tight */}
          <ul className="mt-5 hidden sm:flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-ink/65">
            {capabilities.map((c, i) => (
              <li key={c} className="flex items-center gap-2.5">
                {i > 0 && <span className="hidden sm:inline-block h-1 w-1 rounded-full bg-ink/20" aria-hidden />}
                <span>{c}</span>
              </li>
            ))}
          </ul>

          {/* reassurance — on phones/small screens this rides ABOVE the buttons
              so the thin caption stays in the clean copy band and never lands on
              the sun/gate behind it. The solid buttons below sit happily over the
              scene. At md+ the same line tucks inline beside the ctas instead. */}
          <p className="md:hidden mt-4 sm:mt-5 text-xs text-ink/45">
            No credit card. Free up to 100 msgs / month.
          </p>

          {/* ctas */}
          <div className="mt-3 sm:mt-7 flex flex-wrap items-center gap-3">
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
            <span className="hidden md:inline text-xs text-ink/45 ml-1">
              No credit card. Free up to 100 msgs / month.
            </span>
          </div>
        </div>

        {/* ── right: the gate — open & sunlit by day, shut & locked by night.
            Two compositions sharing one set of animations: a compact landscape
            "gateway band" below lg (fits a phone viewport, grounded against the
            trust band), and the full portrait scene at lg+ beside the copy. ── */}
        <div className="hidden lg:block lg:col-span-5 min-w-0 order-2 relative">
          <div className="mx-auto max-w-[500px]">
            <HeroGateDayNight className="block w-full h-auto" />
          </div>
        </div>
      </div>

      {/* ── trust band: hardware integrations + 3 hard metrics ─────── */}
      <div className="border-y border-ink/10 bg-paper-warm/40">
        <div className="mx-auto max-w-[1280px] px-5 sm:px-6 lg:px-10 py-4 sm:py-5 grid grid-cols-12 gap-y-4 sm:gap-x-8 items-center">
          <div className="col-span-12 md:col-span-5">
            <span className="text-[10px] uppercase tracking-[0.22em] text-ink/55">
              Talks to your hardware
            </span>
            <ul className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 font-display text-sm sm:text-base text-ink/85">
              {integrations.map((brand, i) => (
                <li key={brand} className="flex items-center gap-5">
                  <span>{brand}</span>
                  {i < integrations.length - 1 && (
                    <span className="hidden sm:inline-block h-3 w-px bg-ink/20" aria-hidden />
                  )}
                </li>
              ))}
            </ul>
          </div>

          <span className="hidden md:block md:col-span-1 h-10 w-px bg-ink/15 mx-auto" aria-hidden />

          <dl className="col-span-12 md:col-span-6 grid grid-cols-3 gap-4 sm:gap-8">
            <Stat label="Avg open" value="1.8 s" />
            <Stat label="Locations live" value="412" />
            <Stat label="Uptime" value="99.98%" />
          </dl>
        </div>
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-[0.18em] text-ink/45">
        {label}
      </dt>
      <dd className="font-display text-lg sm:text-xl mt-0.5 tabular-nums">{value}</dd>
    </div>
  );
}
