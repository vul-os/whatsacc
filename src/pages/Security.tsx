import { TopNav } from '@/components/nav/TopNav';
import { Footer } from '@/components/landing/Footer';

const pillars = [
  {
    n: '01',
    title: 'Identity by phone number',
    body: 'Every member is bound to a verified WhatsApp number. We never accept commands from senders we don\'t know — silently dropped, never quietly considered.',
  },
  {
    n: '02',
    title: 'Row-level isolation',
    body: 'Account → Location → AccessPoint is enforced at the database. A query that doesn\'t carry the right account scope returns zero rows. There is no admin override that bypasses it.',
  },
  {
    n: '03',
    title: 'Per-device keys',
    body: 'Each controller has its own keypair. The signed open command is replay-protected with a sliding nonce window. Rotating a device doesn\'t require touching the rest.',
  },
  {
    n: '04',
    title: 'Geofence checks',
    body: 'Optional per-location radius. We accept WhatsApp shared location or a live ping. Outside the radius we deny the open and write the verdict — including the GPS distance — to the audit log.',
  },
  {
    n: '05',
    title: 'Audit log',
    body: 'Every event — opens, denies, pairings, member changes — is appended with the actor, the location, the verdict, and the upstream message id. Exportable as CSV. Retained as long as you like — it’s your database.',
  },
  {
    n: '06',
    title: 'Sensible failure modes',
    body: 'If the gateway is unreachable, the controller falls back to its last good policy and a local PIN. Opens are queued for up to 30 seconds across brief network issues, not lost.',
  },
];

export default function Security() {
  return (
    <div className="bg-paper">
      <TopNav />

      <section className="mx-auto max-w-[1280px] px-5 sm:px-6 lg:px-10 pt-16 sm:pt-20 lg:pt-28 pb-12 sm:pb-16">
        <span className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-ink/55">
          <span className="h-1 w-1 rounded-full bg-terracotta" aria-hidden />
          Trust
        </span>
        <h1 className="font-display-tight text-[40px] sm:text-6xl lg:text-[80px] leading-[0.96] tracking-[-0.02em] mt-4 max-w-4xl">
          A gate is the smallest <em className="italic text-terracotta">serious</em> piece of infrastructure in your day.
        </h1>
        <p className="mt-6 sm:mt-8 max-w-xl text-ink/70 text-base sm:text-lg leading-relaxed">
          Here&rsquo;s how whatsacc earns the right to open one.
        </p>
      </section>

      <section className="mx-auto max-w-[1280px] px-5 sm:px-6 lg:px-10 pb-20 sm:pb-24">
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-px bg-ink/12 border border-ink/12 rounded-2xl overflow-hidden">
          {pillars.map((p) => (
            <li key={p.n} className="bg-paper p-7 sm:p-9 lg:p-10 relative">
              <span className="numeral text-terracotta text-base tabular-nums tracking-[0.06em]">{p.n}</span>
              <h3 className="font-display text-xl sm:text-2xl mt-3 tracking-[-0.005em]">{p.title}</h3>
              <p className="mt-3 text-ink/70 leading-relaxed text-[15px]">{p.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mx-auto max-w-[1280px] px-5 sm:px-6 lg:px-10 pb-24 sm:pb-32">
        <div className="relative rounded-2xl bg-ink text-paper p-8 sm:p-10 lg:p-12 grid grid-cols-1 lg:grid-cols-2 gap-8 sm:gap-10 items-center overflow-hidden">
          <span className="hidden lg:block absolute top-5 left-5 h-2.5 w-2.5 border-l border-t border-paper/25" aria-hidden />
          <span className="hidden lg:block absolute top-5 right-5 h-2.5 w-2.5 border-r border-t border-paper/25" aria-hidden />
          <span className="hidden lg:block absolute bottom-5 left-5 h-2.5 w-2.5 border-l border-b border-paper/25" aria-hidden />
          <span className="hidden lg:block absolute bottom-5 right-5 h-2.5 w-2.5 border-r border-b border-paper/25" aria-hidden />

          <div className="relative">
            <span className="inline-flex items-center gap-2 text-[10px] uppercase tracking-[0.22em] text-paper/55">
              <span className="h-1 w-1 rounded-full bg-terracotta-soft" aria-hidden />
              Talk to an engineer
            </span>
            <h3 className="mt-4 font-display-tight text-3xl sm:text-4xl lg:text-[44px] leading-[1.02] tracking-[-0.02em]">
              Have a security review to run?
            </h3>
            <p className="mt-4 text-paper/75 leading-relaxed max-w-md text-[15px]">
              We&rsquo;re happy to walk through our model with your IT team or HOA committee. No
              sales gauntlet — just an engineer who built it.
            </p>
          </div>
          <div className="relative lg:justify-self-end">
            <a
              href="mailto:security@whatsacc.io"
              className="inline-flex h-12 px-6 items-center rounded-full bg-paper text-ink font-medium hover:bg-terracotta hover:text-paper transition-colors"
            >
              security@whatsacc.io
            </a>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
