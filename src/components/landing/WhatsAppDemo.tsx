import { ArchMark } from '@/components/illustrations/ArchMark';

function MapThumb() {
  return (
    <svg viewBox="0 0 220 130" className="w-full h-auto rounded-md" aria-hidden>
      <defs>
        <linearGradient id="land" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#E8E2D5" />
          <stop offset="1" stopColor="#D9D0BD" />
        </linearGradient>
      </defs>
      <rect width="220" height="130" fill="url(#land)" />
      <path d="M0 70 C 40 60, 80 80, 130 70 S 200 60, 220 72 L 220 130 L 0 130 Z" fill="#CFE5C8" />
      <path d="M-10 28 Q 80 24 220 38 L 220 30 Q 110 18 -10 22 Z" fill="#B7D8F0" opacity="0.85" />
      <g stroke="#B5AB95" strokeWidth="1.4" fill="none" opacity="0.85">
        <path d="M0 96 L 220 84" />
        <path d="M0 110 L 220 102" />
        <path d="M44 130 L 60 0" />
        <path d="M148 130 L 168 0" />
      </g>
      <g fill="#A89E84" opacity="0.55">
        <rect x="14" y="80" width="20" height="14" rx="2" />
        <rect x="78" y="100" width="26" height="16" rx="2" />
        <rect x="120" y="78" width="22" height="14" rx="2" />
        <rect x="180" y="98" width="20" height="14" rx="2" />
      </g>
      {/* pin */}
      <g transform="translate(110 60)">
        <ellipse cx="0" cy="20" rx="8" ry="2.5" fill="#000" opacity="0.18" />
        <path d="M0 -22 C 9 -22 12 -14 8 -6 L 0 14 L -8 -6 C -12 -14 -9 -22 0 -22 Z" fill="#D6624D" />
        <circle cx="0" cy="-15" r="3.4" fill="#F4EDE2" />
      </g>
    </svg>
  );
}

function Tick({ read = true }: { read?: boolean }) {
  const c = read ? '#34B7F1' : '#8696A0';
  return (
    <svg viewBox="0 0 16 12" className="inline-block w-3.5 h-3 ml-1 align-baseline" aria-hidden>
      <path
        d="M1 6.5 L 4.5 10 L 10.5 2"
        fill="none"
        stroke={c}
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5.5 6.5 L 9 10 L 15 2"
        fill="none"
        stroke={c}
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IncomingTail() {
  return (
    <svg
      className="absolute -left-2 top-0 w-3 h-3"
      viewBox="0 0 12 12"
      aria-hidden
    >
      <path d="M12 0 L 0 0 L 12 12 Z" fill="#FFFFFF" />
    </svg>
  );
}

function OutgoingTail() {
  return (
    <svg
      className="absolute -right-2 top-0 w-3 h-3"
      viewBox="0 0 12 12"
      aria-hidden
    >
      <path d="M0 0 L 12 0 L 0 12 Z" fill="#D9FDD3" />
    </svg>
  );
}

function Doodle() {
  return (
    <svg
      className="absolute inset-0 w-full h-full opacity-[0.06] pointer-events-none"
      viewBox="0 0 400 600"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden
    >
      <defs>
        <pattern id="wpattern" x="0" y="0" width="160" height="160" patternUnits="userSpaceOnUse">
          <path d="M20 110 q 18 -22 36 0 t 36 0" stroke="#1A1F36" strokeWidth="1" fill="none" />
          <circle cx="120" cy="40" r="2" fill="#1A1F36" />
          <path d="M40 30 l 8 -8 l 8 8 l -8 8 z" stroke="#1A1F36" strokeWidth="1" fill="none" />
          <path d="M90 80 q 6 6 12 0 q 6 -6 12 0" stroke="#1A1F36" strokeWidth="1" fill="none" />
          <circle cx="30" cy="60" r="6" stroke="#1A1F36" strokeWidth="1" fill="none" />
        </pattern>
      </defs>
      <rect width="400" height="600" fill="url(#wpattern)" />
    </svg>
  );
}

export function WhatsAppDemo() {
  return (
    <section className="relative bg-paper-warm overflow-hidden">
      <div className="mx-auto max-w-[1280px] px-5 sm:px-6 lg:px-10 py-16 sm:py-20 md:py-28 lg:py-32">
        <div className="grid grid-cols-12 gap-y-12 sm:gap-y-14 gap-x-6 sm:gap-x-10 items-center">
          {/* Left: copy */}
          <div className="col-span-12 lg:col-span-5 lg:order-1 order-2">
            <span className="text-[11px] uppercase tracking-[0.22em] text-ink/55">
              The whole flow
            </span>
            <h2 className="mt-4 font-display text-4xl sm:text-5xl lg:text-[56px] leading-[1.02] tracking-tight">
              Like sending a text.
              <br />
              <em className="italic text-terracotta">Because it is.</em>
            </h2>
            <p className="mt-6 max-w-md text-ink/70 leading-relaxed">
              Residents share their location, pick a gate, and we open it — every step happens
              inside the same WhatsApp thread they already use. No new app to install. No fob to lose.
            </p>

            <ul className="mt-8 space-y-3 text-sm text-ink/75">
              <li className="flex gap-3">
                <span className="mt-2 h-1 w-3 bg-terracotta shrink-0" />
                <span>Phone number ↔ profile, with optional name + photo for the security team.</span>
              </li>
              <li className="flex gap-3">
                <span className="mt-2 h-1 w-3 bg-terracotta shrink-0" />
                <span>Geofence check rejects anyone outside the configured radius.</span>
              </li>
              <li className="flex gap-3">
                <span className="mt-2 h-1 w-3 bg-terracotta shrink-0" />
                <span>Every open lands in the audit log within the same second.</span>
              </li>
            </ul>
          </div>

          {/* Right: phone */}
          <div className="col-span-12 lg:col-span-7 lg:order-2 order-1 flex justify-center lg:justify-end">
            <div
              className="relative w-full max-w-[300px] sm:max-w-[340px] lg:max-w-[380px] aspect-[9/18.5] rounded-[42px] bg-ink p-[5px] shadow-[0_28px_60px_-20px_rgba(26,31,54,0.45)]"
              style={{ transform: 'rotate(-1.5deg)' }}
            >
              {/* Inner screen */}
              <div className="relative h-full w-full overflow-hidden rounded-[38px] bg-[#ECE5DD]">
                {/* Speaker / notch hint */}
                <div className="absolute top-1.5 left-1/2 -translate-x-1/2 z-30 h-1 w-12 rounded-full bg-ink/80" />

                {/* WhatsApp header */}
                <div className="relative z-20 flex items-center gap-3 bg-[#075E54] px-3 pt-5 pb-3 text-white">
                  <button
                    type="button"
                    aria-label="back"
                    className="grid h-7 w-7 place-items-center rounded-full hover:bg-white/10"
                  >
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M15 18l-6-6 6-6" />
                    </svg>
                  </button>
                  <div className="grid h-9 w-9 place-items-center rounded-full bg-white">
                    <ArchMark className="h-5 w-5 text-[#1A1F36]" />
                  </div>
                  <div className="leading-tight">
                    <div className="text-[14px] font-medium">whatsacc · Stellar Heights</div>
                    <div className="text-[11px] text-white/70">online</div>
                  </div>
                  <div className="ml-auto flex items-center gap-2 text-white/80">
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
                      <path d="M17 10.5V7c0-.6-.4-1-1-1H4c-.6 0-1 .4-1 1v10c0 .6.4 1 1 1h12c.6 0 1-.4 1-1v-3.5l4 4v-11l-4 4z" />
                    </svg>
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
                      <path d="M20 15.5c-1.2 0-2.5-.2-3.6-.6-.3-.1-.7 0-1 .2l-2.2 2.2a15.2 15.2 0 01-6.6-6.6l2.2-2.2c.3-.3.4-.7.2-1-.4-1.1-.6-2.4-.6-3.6 0-.6-.4-1-1-1H4c-.6 0-1 .4-1 1 0 9.4 7.6 17 17 17 .6 0 1-.4 1-1v-3.4c0-.6-.4-1-1-1z" />
                    </svg>
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
                      <circle cx="12" cy="6" r="1.5" />
                      <circle cx="12" cy="12" r="1.5" />
                      <circle cx="12" cy="18" r="1.5" />
                    </svg>
                  </div>
                </div>

                {/* Chat body */}
                <div className="relative h-[calc(100%-110px)] overflow-hidden">
                  <Doodle />

                  <div className="relative z-10 flex flex-col gap-2 px-3 pt-4 pb-3">
                    {/* Day separator */}
                    <div className="self-center my-1 rounded-md bg-[#E1F2FB] px-2.5 py-1 text-[10.5px] text-[#5C7A89] shadow-sm">
                      TODAY
                    </div>

                    {/* Incoming: greeting */}
                    <div className="relative max-w-[78%] self-start rounded-md rounded-tl-none bg-white px-2.5 pt-1.5 pb-1 shadow-[0_1px_0.5px_rgba(0,0,0,0.13)]">
                      <IncomingTail />
                      <p className="text-[13.5px] leading-snug text-ink">
                        Hey Yusuf 👋 you have access to <b>3 gates</b> at <b>Stellar Heights</b>. Share your location to start.
                      </p>
                      <div className="mt-0.5 flex justify-end items-baseline gap-1 text-[10.5px] text-ink/45">
                        <span>09:41</span>
                      </div>
                    </div>

                    {/* Outgoing: location share */}
                    <div className="relative max-w-[80%] self-end rounded-md rounded-tr-none bg-[#D9FDD3] p-1.5 pb-1 shadow-[0_1px_0.5px_rgba(0,0,0,0.13)]">
                      <OutgoingTail />
                      <div className="overflow-hidden rounded-md">
                        <MapThumb />
                      </div>
                      <div className="px-1 pt-1.5">
                        <div className="flex items-start gap-1.5">
                          <svg viewBox="0 0 16 16" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#075E54]" fill="currentColor" aria-hidden>
                            <path d="M8 0a5 5 0 00-5 5c0 3.6 5 11 5 11s5-7.4 5-11a5 5 0 00-5-5zm0 7a2 2 0 110-4 2 2 0 010 4z" />
                          </svg>
                          <div className="leading-tight">
                            <div className="text-[12.5px] font-medium text-ink">Live location</div>
                            <div className="text-[11px] text-ink/55">Stellar Heights, Sunset Ave</div>
                          </div>
                        </div>
                        <div className="mt-1 flex justify-end items-baseline gap-1 text-[10.5px] text-ink/45">
                          <span>09:41</span>
                          <Tick read />
                        </div>
                      </div>
                    </div>

                    {/* Incoming: which gate? */}
                    <div className="relative max-w-[78%] self-start rounded-md rounded-tl-none bg-white px-2.5 pt-1.5 pb-1 shadow-[0_1px_0.5px_rgba(0,0,0,0.13)]">
                      <IncomingTail />
                      <p className="text-[13.5px] leading-snug text-ink">
                        Got it — you&rsquo;re <b>14&nbsp;m</b> from the perimeter. Which gate would you like to open?
                      </p>
                      <div className="mt-0.5 flex justify-end items-baseline gap-1 text-[10.5px] text-ink/45">
                        <span>09:41</span>
                      </div>
                    </div>

                    {/* Quick-reply buttons (WhatsApp interactive) */}
                    <div className="self-start w-[78%] max-w-[78%] flex flex-col gap-px overflow-hidden rounded-md bg-white shadow-[0_1px_0.5px_rgba(0,0,0,0.13)]">
                      <button type="button" className="flex items-center justify-center gap-1.5 px-2 py-2 text-[13px] font-medium text-[#027EB5]">
                        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
                          <path d="M5 11h14v2H5z M11 5h2v14h-2z" />
                        </svg>
                        Front gate
                      </button>
                      <div className="h-px bg-[#E5E5E5]" />
                      <button type="button" className="flex items-center justify-center gap-1.5 px-2 py-2 text-[13px] font-medium text-[#027EB5]">
                        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
                          <path d="M5 11h14v2H5z M11 5h2v14h-2z" />
                        </svg>
                        Visitor gate
                      </button>
                      <div className="h-px bg-[#E5E5E5]" />
                      <button type="button" className="flex items-center justify-center gap-1.5 px-2 py-2 text-[13px] font-medium text-[#027EB5]">
                        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
                          <path d="M5 11h14v2H5z M11 5h2v14h-2z" />
                        </svg>
                        Garage
                      </button>
                    </div>

                    {/* Outgoing: pick */}
                    <div className="relative max-w-[80%] self-end rounded-md rounded-tr-none bg-[#D9FDD3] px-2.5 pt-1.5 pb-1 shadow-[0_1px_0.5px_rgba(0,0,0,0.13)]">
                      <OutgoingTail />
                      <p className="text-[13.5px] leading-snug text-ink">Front gate</p>
                      <div className="mt-0.5 flex justify-end items-baseline gap-1 text-[10.5px] text-ink/45">
                        <span>09:41</span>
                        <Tick read />
                      </div>
                    </div>

                    {/* Incoming: confirmation */}
                    <div className="relative max-w-[80%] self-start rounded-md rounded-tl-none bg-white px-2.5 pt-1.5 pb-1.5 shadow-[0_1px_0.5px_rgba(0,0,0,0.13)]">
                      <IncomingTail />
                      <div className="flex items-center gap-2">
                        <span className="grid h-6 w-6 place-items-center rounded-full bg-[#25D366]/15 text-[#1F8A3F]">
                          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        </span>
                        <p className="text-[13.5px] leading-snug text-ink">
                          <b>Front gate</b> is open · <span className="text-ink/60">7.2&nbsp;s</span>
                        </p>
                      </div>
                      <div className="mt-1 ml-8 text-[11px] text-ink/55 leading-snug">
                        Logged · device&nbsp;#SH-G1 · audit&nbsp;<span className="font-mono">a3f9c2</span>
                      </div>
                      <div className="mt-0.5 flex justify-end items-baseline gap-1 text-[10.5px] text-ink/45">
                        <span>09:41</span>
                      </div>
                    </div>

                    {/* Typing indicator (decorative) */}
                    <div className="self-end mt-1 flex items-center gap-1 text-[10.5px] text-ink/45">
                      <span>delivered</span>
                      <Tick read />
                    </div>
                  </div>
                </div>

                {/* Input bar */}
                <div className="absolute bottom-0 left-0 right-0 z-20 flex items-center gap-2 bg-[#F0F0F0] px-2 py-1.5">
                  <div className="flex-1 flex items-center gap-2 rounded-full bg-white px-3 py-1.5 shadow-sm">
                    <svg viewBox="0 0 24 24" className="h-4 w-4 text-ink/40" fill="currentColor" aria-hidden>
                      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="1.6" />
                      <circle cx="9" cy="10" r="1" />
                      <circle cx="15" cy="10" r="1" />
                      <path d="M8 14c1 1.5 2.5 2.2 4 2.2S15 15.5 16 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                    </svg>
                    <span className="flex-1 text-[13px] text-ink/40">Message</span>
                    <svg viewBox="0 0 24 24" className="h-4 w-4 text-ink/40" fill="currentColor" aria-hidden>
                      <path d="M21 16.5l-9-9-9 9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <svg viewBox="0 0 24 24" className="h-4 w-4 text-ink/40" fill="currentColor" aria-hidden>
                      <path d="M9 9V5a3 3 0 116 0v8a3 3 0 11-6 0V8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    </svg>
                  </div>
                  <button
                    type="button"
                    className="grid h-9 w-9 place-items-center rounded-full bg-[#075E54] text-white"
                    aria-label="send"
                  >
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
                      <path d="M3 11l18-8-8 18-2-8-8-2z" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
