import { TopNav } from '@/components/nav/TopNav';
import { Footer } from '@/components/landing/Footer';

const pillars = [
  {
    n: '01',
    title: 'Channel-verified, not phone-verified',
    body: 'Every WhatsApp, Slack and Telegram message is checked against that platform\'s own signature (Meta HMAC, Slack\'s signing secret, Telegram\'s secret token) before we read it — fail closed. lintel doesn\'t independently verify who owns a phone number; that\'s deferred, not shipped. An unrecognized sender isn\'t silently ignored either — they get a signup link back, so an unknown number is visible, not dropped.',
  },
  {
    n: '02',
    title: 'Tenancy, scoped in application code',
    body: 'Account → Location → AccessPoint scoping is enforced by the Go handlers, not by the database — SQLite has no row-level security to fall back on. Every store method that touches tenant data takes an account ID and applies it to the query; it\'s consistent, and it\'s the actual mechanism, but it\'s discipline, not a database guarantee.',
  },
  {
    n: '03',
    title: 'Signed commands, one gateway key',
    body: 'Every open your gateway sends is Ed25519-signed, nonce-protected and expires in 30 seconds; each controller pins that key at pairing and never trusts network position. What\'s not per-device: the signing key itself is one keypair for the whole install, plaintext on disk. Compromise it and every access point that gateway manages is forgeable until you rotate it.',
  },
  {
    n: '04',
    title: 'Tamper-evident audit log',
    body: 'Every access-log and admin-action row is chained by hash to the one before it, and the chain can be verified independently of the running server — a read-only check against a cold backup, or GET /v1/admin/audit/verify. Direct database edits are detectable, not preventable: an attacker who edits a row and recomputes every hash after it can still rewrite history. There\'s no CSV export today, and no message-id column on the log itself.',
  },
  {
    n: '05',
    title: 'Geofencing: an honest non-feature',
    body: 'There is no geofencing code in lintel today — no radius check, no denied-outside-range verdict. A location shared over chat is asserted by the sender\'s device and trivially spoofable, so if we ever ship it, it\'ll be an advisory signal recorded for review, never a reason to deny an open on its own.',
  },
  {
    n: '06',
    title: 'Brute-force limits, live revocation',
    body: 'Login, registration, token refresh and the one-shot admin claim are all rate-limited per IP and, on login, per account — fails closed, not open. Disabling a user cuts off their very next request, and logout-all ends every session on every device. It can\'t reach back and kill an access token already issued (those expire on their own within 15 minutes) — that\'s the bound, stated plainly.',
  },
];

const limitations = [
  'The binary serves plain HTTP. There\'s no built-in TLS or ACME — that\'s a reverse proxy in front of the gateway, your job as the operator.',
  'The data directory holds the database, the gateway\'s signing key, and the session-signing secret side by side, all unencrypted at mode 0600. A careless `tar czf backup.tgz ./data` captures all three — encrypt the archive, not just the folder permissions.',
  'The offline emergency-access path is three of four pieces built: the contract, the controller-side check and the gateway\'s grant issuance are real and tested. The app that would hold and present a grant on a resident\'s phone isn\'t built yet, so the path doesn\'t run end-to-end for anyone today.',
  'We deliberately don\'t claim end-to-end encrypted messaging — chat channels are WhatsApp\'s, Slack\'s and Telegram\'s infrastructure, and the gateway has to read a message to act on it.',
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
          Here&rsquo;s how lintel earns the right to open one.
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

      <section className="mx-auto max-w-[1280px] px-5 sm:px-6 lg:px-10 pb-20 sm:pb-24">
        <span className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-ink/55">
          <span className="h-1 w-1 rounded-full bg-terracotta" aria-hidden />
          What we don&rsquo;t claim
        </span>
        <p className="mt-4 max-w-2xl text-ink/70 text-base leading-relaxed">
          A trust page that only lists what’s solid isn’t trustworthy. Here’s what
          we know is limited, deferred or your responsibility as the operator.
        </p>
        <ul className="mt-8 grid grid-cols-1 gap-px bg-ink/12 border border-ink/12 rounded-2xl overflow-hidden">
          {limitations.map((l) => (
            <li key={l.slice(0, 24)} className="bg-paper p-6 sm:p-7 text-ink/70 leading-relaxed text-[15px]">
              {l}
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
              href="mailto:vulosorg@gmail.com"
              className="inline-flex h-12 px-6 items-center rounded-full bg-paper text-ink font-medium hover:bg-terracotta hover:text-paper transition-colors"
            >
              vulosorg@gmail.com
            </a>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
