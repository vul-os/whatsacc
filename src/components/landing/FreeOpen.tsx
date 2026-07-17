import { LinkButton } from '@/components/ui/Button';

// whatsacc costs nothing: there is no hosted service and no billing code —
// every gateway is one somebody runs themselves. This section is a
// statement, not a plan table.
const pillars = [
  {
    name: 'Your gateway',
    tag: 'yours',
    blurb:
      'Sign up on your gateway, pair a device, open your gate. Accounts live on the instance you (or someone you trust) run — no card, no tiers, no metered messages.',
    bullets: ['All features included', 'Unlimited locations & members', 'Audit log & analytics'],
    cta: 'Start now',
    href: '/signup',
    accent: true,
  },
  {
    name: 'Run your own',
    tag: 'open source',
    blurb:
      'The whole gateway is MIT-licensed. Clone it, run it on your own box, point your controller at it. No strings back to us.',
    bullets: ['MIT license', 'Self-host the full stack', 'Your data stays yours'],
    cta: 'Read the docs',
    href: '/docs',
    accent: false,
  },
];

export function FreeOpen() {
  return (
    <section className="relative">
      <div className="mx-auto max-w-[1280px] px-5 sm:px-6 lg:px-10 py-20 md:py-24">
        <div className="grid grid-cols-12 sm:gap-x-8 gap-y-6 mb-12 md:mb-14 items-end">
          <div className="col-span-12 lg:col-span-7">
            <span className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-ink/55">
              <span className="h-1 w-1 rounded-full bg-terracotta" aria-hidden />
              Free &amp; open
            </span>
            <h2 className="mt-4 font-display-tight text-4xl sm:text-5xl lg:text-[64px] leading-[0.96] tracking-[-0.02em]">
              No bill. No meter. <em className="italic text-terracotta">No catch.</em>
            </h2>
          </div>
          <p className="col-span-12 lg:col-span-5 text-ink/70 leading-relaxed">
            whatsacc is fully open source under the MIT license. The gateway, the controllers,
            this very portal — you run all of it yourself. Same code, every feature, no editions.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 lg:gap-5 lg:items-start">
          {pillars.map((p) => (
            <div
              key={p.name}
              className={`relative rounded-3xl p-7 sm:p-8 lg:p-10 border flex flex-col ${
                p.accent ? 'bg-ink text-paper border-ink' : 'bg-paper-cool border-ink/10'
              }`}
            >
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="font-display text-3xl">{p.name}</h3>
                <span
                  className={`text-[11px] uppercase tracking-[0.18em] text-right ${
                    p.accent ? 'text-paper/60' : 'text-ink/55'
                  }`}
                >
                  {p.tag}
                </span>
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
          Want to charge your residents? That&rsquo;s your business — literally. Nothing in
          whatsacc does billing. The only bills are your own hardware and your own server.
        </p>
      </div>
    </section>
  );
}
