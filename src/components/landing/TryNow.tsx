// Official WhatsApp mark — SimpleIcons / Meta brand asset.
function WhatsAppLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      role="img"
      aria-label="WhatsApp"
    >
      <path
        fill="#25D366"
        d="M.057 24l1.687-6.163a11.867 11.867 0 0 1-1.587-5.946C.16 5.335 5.495 0 12.05 0a11.817 11.817 0 0 1 8.413 3.488 11.824 11.824 0 0 1 3.48 8.414c-.003 6.557-5.338 11.892-11.893 11.892a11.9 11.9 0 0 1-5.688-1.448L.057 24zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884a9.872 9.872 0 0 0 1.5 5.299l-.999 3.648 3.988-1.046zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.521.151-.172.2-.296.3-.495.099-.198.05-.372-.025-.521-.075-.148-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.095 3.2 5.076 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414z"
      />
    </svg>
  );
}

// Official Slack mark — SimpleIcons / Salesforce brand asset.
function SlackLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      role="img"
      aria-label="Slack"
    >
      <path
        fill="#E01E5A"
        d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z"
      />
      <path
        fill="#36C5F0"
        d="M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z"
      />
      <path
        fill="#2EB67D"
        d="M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312z"
      />
      <path
        fill="#ECB22E"
        d="M15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"
      />
    </svg>
  );
}

function Arrow({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden>
      <path
        d="M3 8h10M9 4l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const PHONE_DISPLAY = '+27 68 779 8343';
const PHONE_INTL = '27687798343';
const SLACK_HANDLE = '@acc_bot';
const WA_HREF = `https://wa.me/${PHONE_INTL}?text=open`;

export function TryNow() {
  return (
    <section className="relative bg-paper border-y border-ink/10">
      <div className="mx-auto max-w-[1280px] px-5 sm:px-6 lg:px-10 py-16 sm:py-20 lg:py-24">
        <div className="grid grid-cols-12 gap-y-10 sm:gap-x-10 items-start">
          {/* ── Left: headline + context ─────────────────────────────── */}
          <div className="col-span-12 lg:col-span-5">
            <span className="text-[11px] uppercase tracking-[0.22em] text-ink/55">
              Open one, right now
            </span>
            <h2 className="mt-3 font-display text-4xl sm:text-5xl lg:text-[56px] leading-[1.02] tracking-tight text-ink">
              Try it from{' '}
              <em
                className="italic text-terracotta"
                style={{ fontVariationSettings: '"SOFT" 100' }}
              >
                your
              </em>{' '}
              phone.
            </h2>
            <p className="mt-5 max-w-md text-ink/70 leading-relaxed">
              Send the word{' '}
              <span className="inline-flex items-baseline rounded bg-paper-warm border border-ink/10 px-1.5 py-0.5 font-mono text-[13px] text-ink">
                open
              </span>{' '}
              on either channel below. The bot replies in under a second — so
              you can feel the response time before you run your own.
            </p>

            <div className="mt-7 flex items-center gap-2.5 text-[12px] text-ink/55">
              <span className="relative flex h-2 w-2" aria-hidden>
                <span
                  className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-70"
                  style={{ backgroundColor: '#25D366' }}
                />
                <span
                  className="relative inline-flex h-2 w-2 rounded-full"
                  style={{ backgroundColor: '#25D366' }}
                />
              </span>
              <span>Live — a demo gateway we run: one instance of the same MIT code you self-host.</span>
            </div>
          </div>

          {/* ── Right: channel cards ─────────────────────────────────── */}
          <div className="col-span-12 lg:col-span-7 grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* WhatsApp */}
            <a
              href={WA_HREF}
              target="_blank"
              rel="noopener noreferrer"
              className="group relative flex flex-col rounded-2xl border border-ink/10 bg-paper-warm/30 p-5 sm:p-6 transition hover:-translate-y-0.5 hover:border-ink/25 hover:bg-paper-warm/60 hover:shadow-[0_18px_40px_-22px_rgba(26,31,54,0.35)]"
            >
              <div className="flex items-center justify-between">
                <WhatsAppLogo className="h-9 w-9" />
                <span className="text-[10px] uppercase tracking-[0.22em] text-ink/40">
                  01 · WhatsApp
                </span>
              </div>

              <div className="mt-7">
                <div className="text-[10.5px] uppercase tracking-[0.2em] text-ink/55">
                  Text the bot
                </div>
                <div className="mt-1.5 font-display text-[22px] sm:text-2xl leading-tight text-ink tabular-nums">
                  {PHONE_DISPLAY}
                </div>
              </div>

              <div className="mt-auto pt-6 flex items-center justify-between border-t border-ink/10 text-[12px] text-ink/60">
                <span>Tap to chat — message pre-filled</span>
                <span className="inline-flex items-center gap-1 text-ink transition group-hover:text-terracotta">
                  Open
                  <Arrow className="h-3.5 w-3.5" />
                </span>
              </div>
            </a>

            {/* Slack */}
            <div className="group relative flex flex-col rounded-2xl border border-ink/10 bg-paper-warm/30 p-5 sm:p-6">
              <div className="flex items-center justify-between">
                <SlackLogo className="h-9 w-9" />
                <span className="text-[10px] uppercase tracking-[0.22em] text-ink/40">
                  02 · Slack
                </span>
              </div>

              <div className="mt-7">
                <div className="text-[10.5px] uppercase tracking-[0.2em] text-ink/55">
                  Message the bot
                </div>
                <div className="mt-1.5 font-display text-[22px] sm:text-2xl leading-tight text-ink">
                  {SLACK_HANDLE}
                </div>
              </div>

              <div className="mt-auto pt-6 border-t border-ink/10 text-[12px] text-ink/60 leading-relaxed">
                <span className="inline-flex items-baseline rounded bg-paper border border-ink/10 px-1.5 py-0.5 font-mono text-[11px] text-ink mr-1">
                  /invite {SLACK_HANDLE}
                </span>
                in any channel, then send{' '}
                <span className="inline-flex items-baseline rounded bg-paper border border-ink/10 px-1.5 py-0.5 font-mono text-[11px] text-ink">
                  open
                </span>
                .
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
