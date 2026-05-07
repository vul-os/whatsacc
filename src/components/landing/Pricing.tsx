import { LinkButton } from '@/components/ui/Button';
import { useFormatZar } from '@/lib/billing/currency';

// Prices canonical in ZAR — the formatter converts to whatever currency the
// visitor selected in the top-bar selector.
const plans = [
  {
    name: 'Free',
    priceZar: 0,
    cadence: '/ month',
    msgs: '100 messages',
    blurb: 'For a single house. Try it on your own gate first — most people do.',
    bullets: ['1 location', '1 device', 'Audit log · 30 days', 'Email support'],
    cta: 'Start free',
    href: '/signup',
    accent: false,
  },
  {
    name: 'Starter',
    priceZar: 165,
    cadence: '/ month',
    msgs: '2,000 messages',
    blurb: 'Right-sized for a townhouse cluster, a small office, or a busy household.',
    bullets: ['Up to 5 locations', '10 devices', 'Geofence safety', 'Member roles'],
    cta: 'Choose Starter',
    href: '/signup',
    accent: true,
  },
  {
    name: 'Pro',
    priceZar: 900,
    cadence: '/ month',
    msgs: '20,000 messages',
    blurb:
      'For complexes, property managers and security companies running real volume.',
    bullets: [
      'Unlimited locations',
      'Unlimited devices',
      'CSV export · API access',
      'Priority support',
    ],
    cta: 'Talk to us',
    href: '/signup',
    accent: false,
  },
];

const PER_MESSAGE_ZAR = 0.033;

export function Pricing() {
  const formatZar = useFormatZar();
  return (
    <section className="relative">
      <div className="mx-auto max-w-[1280px] px-5 sm:px-6 lg:px-10 py-20 md:py-24">
        <div className="grid grid-cols-12 gap-x-8 gap-y-6 mb-12 md:mb-14 items-end">
          <div className="col-span-12 lg:col-span-7">
            <span className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-ink/55">
              <span className="h-1 w-1 rounded-full bg-terracotta" aria-hidden />
              Pricing
            </span>
            <h2 className="mt-4 font-display-tight text-4xl sm:text-5xl lg:text-[64px] leading-[0.96] tracking-[-0.02em]">
              Pay for messages, not <em className="italic text-terracotta">per seat</em>.
            </h2>
          </div>
          <p className="col-span-12 lg:col-span-5 text-ink/70 leading-relaxed">
            A complex onboarding 200 residents over a weekend shouldn&rsquo;t triple your bill.
            We charge for the only thing that costs us anything &mdash; the messages we send.
          </p>
        </div>

        {/* asymmetric arrangement, middle plan is taller and offset on lg+ */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 lg:gap-5 lg:items-start">
          {plans.map((p) => (
            <div
              key={p.name}
              className={`relative rounded-3xl p-7 sm:p-8 lg:p-10 border flex flex-col ${
                p.accent
                  ? 'bg-ink text-paper border-ink lg:-translate-y-6 lg:py-14'
                  : 'bg-paper-cool border-ink/10'
              }`}
            >
              {p.accent && (
                <span className="absolute -top-3 left-7 sm:left-8 inline-flex items-center gap-2 bg-terracotta text-paper px-3 py-1 rounded-full text-[11px] uppercase tracking-[0.18em]">
                  most chosen
                </span>
              )}
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="font-display text-3xl">{p.name}</h3>
                <span
                  className={`text-[11px] uppercase tracking-[0.18em] text-right ${
                    p.accent ? 'text-paper/60' : 'text-ink/55'
                  }`}
                >
                  {p.msgs}
                </span>
              </div>

              <div className="mt-5 sm:mt-6 flex items-baseline gap-2">
                <span className="font-display text-5xl sm:text-6xl leading-none">
                  {formatZar(p.priceZar)}
                </span>
                <span className={p.accent ? 'text-paper/60' : 'text-ink/55'}>{p.cadence}</span>
              </div>

              <p className={`mt-5 leading-relaxed ${p.accent ? 'text-paper/75' : 'text-ink/70'}`}>
                {p.blurb}
              </p>

              <ul className="mt-6 space-y-2.5">
                {p.bullets.map((b) => (
                  <li
                    key={b}
                    className={`flex items-start gap-3 text-sm ${
                      p.accent ? 'text-paper/85' : 'text-ink/80'
                    }`}
                  >
                    <span
                      className={`mt-2 h-1 w-3 shrink-0 ${
                        p.accent ? 'bg-terracotta-soft' : 'bg-terracotta'
                      }`}
                    />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-auto pt-8">
                <LinkButton
                  to={p.href}
                  variant={p.accent ? 'primary' : 'outline'}
                  size="md"
                  className="w-full"
                >
                  {p.cta}
                </LinkButton>
              </div>
            </div>
          ))}
        </div>

        <p className="mt-10 text-sm text-ink/55 text-center max-w-md mx-auto">
          Need more than 20,000 messages a month?{' '}
          <a href="/signup" className="underline underline-offset-4 decoration-terracotta">
            Talk to us
          </a>{' '}
          &mdash; we have a per-message rate from {formatZar(PER_MESSAGE_ZAR)}.
        </p>
      </div>
    </section>
  );
}
