import { ChatToGate } from '@/components/illustrations/ChatToGate';

const steps = [
  {
    n: '01',
    title: 'Send the word',
    body: 'A resident texts open (or any phrase you allow) to your gateway\'s number from WhatsApp. No app to install, no fob to carry.',
  },
  {
    n: '02',
    title: 'We verify, in seconds',
    body: "lintel checks the sender's phone, their permissions for that location, and any admin-set quotas or cooldowns.",
  },
  {
    n: '03',
    title: 'The device opens',
    body: 'A signed open command is delivered to the paired controller. The user gets a reply: unlocked · 7s. Logged with the audit trail.',
  },
];

export function HowItWorks() {
  return (
    <section className="relative">
      <div className="mx-auto max-w-[1280px] px-5 sm:px-6 lg:px-10 py-20 md:py-24">
        <div className="grid grid-cols-12 sm:gap-x-8 gap-y-10 md:gap-y-12">
          <div className="col-span-12 lg:col-span-4">
            <span className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-ink/55">
              <span className="h-1 w-1 rounded-full bg-terracotta" aria-hidden />
              How it works
            </span>
            <h2 className="mt-4 font-display-tight text-4xl sm:text-5xl lg:text-[56px] leading-[0.96] tracking-[-0.02em]">
              Three moments, <em className="italic text-terracotta">two seconds</em>.
            </h2>
            <p className="mt-5 max-w-sm text-ink/70 leading-relaxed">
              The whole experience hides behind one familiar place &mdash; a chat thread.
              Everything else is lintel&rsquo;s job.
            </p>
          </div>

          <div className="col-span-12 lg:col-span-8">
            <div className="rounded-2xl bg-paper-warm border border-ink/10 p-4 sm:p-6 lg:p-10">
              <ChatToGate className="w-full h-auto" />
            </div>
          </div>
        </div>

        <ol className="mt-14 md:mt-16 grid grid-cols-1 md:grid-cols-3 gap-y-10 md:gap-x-8">
          {steps.map((s, i) => (
            <li key={s.n} className="relative">
              {/* numeral row: numeral · dot · connector */}
              <div className="flex items-center">
                <span className="numeral text-3xl text-terracotta tabular-nums leading-none">
                  {s.n}
                </span>
                <span className="ml-3 h-1.5 w-1.5 rounded-full bg-ink shrink-0" />
                {/* horizontal connector visible only on md+ between non-last steps */}
                {i < steps.length - 1 && (
                  <span
                    aria-hidden
                    className="hidden md:block ml-3 flex-1 h-px bg-ink/20"
                  />
                )}
              </div>

              <h3 className="mt-5 font-display text-2xl">{s.title}</h3>
              <p className="mt-3 text-ink/70 leading-relaxed max-w-[32ch] md:max-w-[28ch]">
                {s.body}
              </p>

              {/* mobile-only vertical tick to chain steps */}
              {i < steps.length - 1 && (
                <span
                  aria-hidden
                  className="md:hidden mt-6 block h-6 w-px bg-ink/20 ml-[18px]"
                />
              )}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
