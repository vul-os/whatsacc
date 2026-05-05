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
    body: 'Every event — opens, denies, pairings, member changes — is appended with the actor, the location, the verdict, and the upstream message id. Exportable as CSV. Retained per your plan.',
  },
  {
    n: '06',
    title: 'Sensible failure modes',
    body: 'If our service is unavailable, the controller falls back to its last good policy and a local PIN. Opens are queued for up to 30 seconds across brief network issues, not lost.',
  },
];

export default function Security() {
  return (
    <div className="bg-paper">
      <TopNav />

      <section className="mx-auto max-w-[1280px] px-6 lg:px-10 py-20 lg:py-28">
        <span className="text-[11px] uppercase tracking-[0.22em] text-ink/55">Trust</span>
        <h1 className="font-display-tight text-6xl lg:text-8xl leading-[0.95] mt-4 max-w-4xl">
          A gate is the smallest <em className="italic text-terracotta">serious</em> piece of infrastructure
          in your day.
        </h1>
        <p className="mt-8 max-w-xl text-ink/70 text-lg leading-relaxed">
          Here&rsquo;s how whatsacc earns the right to open one.
        </p>
      </section>

      <section className="mx-auto max-w-[1280px] px-6 lg:px-10 pb-24">
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-px bg-ink/15 border border-ink/15 rounded-3xl overflow-hidden">
          {pillars.map((p) => (
            <li key={p.n} className="bg-paper p-8 lg:p-10 relative">
              <span className="numeral text-terracotta text-lg tabular-nums">{p.n}</span>
              <h3 className="font-display text-2xl mt-3">{p.title}</h3>
              <p className="mt-3 text-ink/70 leading-relaxed">{p.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mx-auto max-w-[1280px] px-6 lg:px-10 pb-32">
        <div className="rounded-3xl bg-ink text-paper p-8 lg:p-12 grid grid-cols-1 lg:grid-cols-2 gap-10 items-center">
          <div>
            <h3 className="font-display-tight text-4xl lg:text-5xl leading-tight">
              Have a security review to run?
            </h3>
            <p className="mt-4 text-paper/75 leading-relaxed max-w-md">
              We&rsquo;re happy to walk through our model with your IT team or HOA committee. No
              sales gauntlet — just an engineer who built it.
            </p>
          </div>
          <div className="lg:justify-self-end">
            <a
              href="mailto:security@whatsacc.io"
              className="inline-flex h-12 px-6 items-center rounded-full bg-paper text-ink font-medium"
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
