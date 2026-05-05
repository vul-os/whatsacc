const features = [
  {
    kicker: 'a',
    title: 'WhatsApp-native',
    body: 'No app, no friction. Anyone with a phone number you trust can text the gate. Replies come back inline — paired, opening, unlocked.',
    span: 'md:col-span-7',
    visual: <ChatBubbleVisual />,
  },
  {
    kicker: 'b',
    title: 'Geofence safety',
    body: 'Block opens from across town. Set a per-location radius and require live location confirmation when stakes are high.',
    span: 'md:col-span-5',
    visual: <GeofenceVisual />,
  },
  {
    kicker: 'c',
    title: 'Multi-tenant locations',
    body: 'House → Building → Complex. Move members between properties without re-pairing devices. Roles inherit, then override.',
    span: 'md:col-span-5',
    visual: <HierarchyVisual />,
  },
  {
    kicker: 'd',
    title: 'Per-device pairing',
    body: 'Every controller has its own signed key. If a device is lost or replaced you rotate it without touching the rest.',
    span: 'md:col-span-7',
    visual: <PairingVisual />,
  },
  {
    kicker: 'e',
    title: 'Wallet billing',
    body: 'Pay per message in batches. No per-seat surprises when a complex onboards 200 residents over a weekend.',
    span: 'md:col-span-4',
    visual: <WalletVisual />,
  },
  {
    kicker: 'f',
    title: 'Audit log + analytics',
    body: 'Every event logged with sender, location and verdict. Export to CSV for HOA meetings or insurance claims.',
    span: 'md:col-span-8',
    visual: <AuditVisual />,
  },
];

export function Features() {
  return (
    <section className="relative">
      <div className="mx-auto max-w-[1280px] px-5 sm:px-6 lg:px-10 py-20 md:py-24 lg:py-32">
        <div className="grid grid-cols-12 gap-x-8 gap-y-8 items-end mb-12 md:mb-14">
          <div className="col-span-12 lg:col-span-6">
            <span className="text-[11px] uppercase tracking-[0.22em] text-ink/55">Features</span>
            <h2 className="mt-4 font-display-tight text-4xl sm:text-5xl lg:text-7xl leading-[0.95]">
              Quietly serious
              <br />
              <em className="italic">about access.</em>
            </h2>
          </div>
          <div className="col-span-12 lg:col-span-6 lg:pl-12">
            <p className="text-ink/70 leading-relaxed max-w-md">
              We&rsquo;ve picked only the things gate-openers ever actually need. Then we&rsquo;ve
              made sure each one is solid enough to put in front of a body corporate.
            </p>
          </div>
        </div>

        <ul className="grid grid-cols-1 md:grid-cols-12 gap-4">
          {features.map((f) => (
            <li
              key={f.kicker}
              className={`${f.span} group/f rounded-3xl bg-paper-cool border border-ink/8 overflow-hidden p-6 sm:p-8 lg:p-10 md:min-h-[300px] flex flex-col gap-6 transition-colors hover:bg-paper-warm`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-3">
                  <span className="font-display italic text-terracotta text-2xl">{f.kicker}.</span>
                  <h3 className="font-display text-xl sm:text-2xl lg:text-[26px] leading-tight">
                    {f.title}
                  </h3>
                </div>
                <p className="mt-3 text-ink/70 leading-relaxed max-w-md text-[15px]">{f.body}</p>
              </div>

              <div className="self-end max-w-full pointer-events-none opacity-90">
                {f.visual}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function ChatBubbleVisual() {
  return (
    <svg
      viewBox="0 0 240 116"
      className="block w-full max-w-[260px] h-auto"
      aria-hidden
    >
      <g transform="translate(8 8)">
        <rect width="120" height="32" rx="16" fill="#1a1f36" />
        <text x="14" y="20" fill="#f4ede2" fontSize="12" fontFamily="Inter">
          open the gate
        </text>
      </g>
      <g transform="translate(72 60)">
        <rect width="148" height="32" rx="16" fill="#d6624d" />
        <text x="14" y="20" fill="#f4ede2" fontSize="12" fontFamily="Inter">
          unlocked &middot; 7s
        </text>
      </g>
    </svg>
  );
}

function GeofenceVisual() {
  return (
    <svg viewBox="0 0 200 160" className="block w-full max-w-[200px] h-auto" aria-hidden>
      <circle cx="100" cy="65" r="50" fill="none" stroke="#1a1f36" strokeWidth="1.5" strokeDasharray="3 4" />
      <circle cx="100" cy="65" r="30" fill="none" stroke="#d6624d" strokeWidth="1.5" />
      <circle cx="100" cy="65" r="3" fill="#d6624d" />
      <circle cx="80" cy="77" r="4" fill="#1a1f36" />
      <text x="100" y="142" textAnchor="middle" fontFamily="Inter" fontSize="10" fill="#1a1f36" opacity="0.65">
        within 80m
      </text>
    </svg>
  );
}

function HierarchyVisual() {
  return (
    <svg viewBox="0 0 220 80" className="block w-full max-w-[220px] h-auto" aria-hidden>
      <g fontFamily="Inter" fontSize="10">
        <rect x="2" y="4" width="60" height="22" rx="6" fill="#1a1f36" />
        <text x="14" y="19" fill="#f4ede2">
          Account
        </text>
        <line x1="62" y1="15" x2="80" y2="15" stroke="#1a1f36" />

        <rect x="80" y="4" width="60" height="22" rx="6" fill="#c8a45c" stroke="#1a1f36" />
        <text x="92" y="19" fill="#1a1f36">
          Location
        </text>
        <line x1="140" y1="15" x2="158" y2="15" stroke="#1a1f36" />

        <rect x="158" y="0" width="58" height="18" rx="6" fill="#f4ede2" stroke="#1a1f36" />
        <text x="166" y="13" fill="#1a1f36">
          Gate
        </text>
        <rect x="158" y="22" width="58" height="18" rx="6" fill="#f4ede2" stroke="#1a1f36" />
        <text x="166" y="35" fill="#1a1f36">
          Door
        </text>
        <rect x="158" y="44" width="58" height="18" rx="6" fill="#f4ede2" stroke="#1a1f36" />
        <text x="166" y="57" fill="#1a1f36">
          Barrier
        </text>
        <line x1="140" y1="15" x2="158" y2="31" stroke="#1a1f36" />
        <line x1="140" y1="15" x2="158" y2="53" stroke="#1a1f36" />
      </g>
    </svg>
  );
}

function PairingVisual() {
  return (
    <svg viewBox="0 0 240 110" className="block w-full max-w-[240px] h-auto" aria-hidden>
      <g transform="translate(6 24)">
        <rect width="80" height="60" rx="6" fill="#1a1f36" />
        <circle cx="14" cy="14" r="3" fill="#d6624d" />
        <text x="22" y="18" fontSize="10" fill="#f4ede2" fontFamily="JetBrains Mono">
          ACC-01
        </text>
        <rect x="10" y="30" width="60" height="20" fill="#c8a45c" />
      </g>
      <g stroke="#1a1f36" strokeDasharray="2 3" fill="none" strokeWidth="1.2">
        <path d="M96 54 q 30 -20 50 -20" />
        <path d="M96 54 q 30 0 50 0" />
        <path d="M96 54 q 30 20 50 20" />
      </g>
      <g transform="translate(156 10)" fontFamily="Inter" fontSize="9">
        <rect width="60" height="20" rx="4" fill="#f4ede2" stroke="#1a1f36" />
        <text x="6" y="14" fill="#1a1f36">
          key A &middot; main
        </text>
      </g>
      <g transform="translate(156 44)" fontFamily="Inter" fontSize="9">
        <rect width="60" height="20" rx="4" fill="#f4ede2" stroke="#1a1f36" />
        <text x="6" y="14" fill="#1a1f36">
          key B &middot; ped
        </text>
      </g>
      <g transform="translate(156 78)" fontFamily="Inter" fontSize="9">
        <rect width="60" height="20" rx="4" fill="#f4ede2" stroke="#1a1f36" />
        <text x="6" y="14" fill="#1a1f36">
          key C &middot; park
        </text>
      </g>
    </svg>
  );
}

function WalletVisual() {
  return (
    <svg viewBox="0 0 140 90" className="block w-full max-w-[160px] h-auto" aria-hidden>
      <rect x="6" y="14" width="120" height="68" rx="8" fill="#1a1f36" />
      <rect x="14" y="26" width="50" height="6" rx="3" fill="#f4ede2" opacity="0.4" />
      <rect x="14" y="38" width="40" height="3" rx="1.5" fill="#f4ede2" opacity="0.3" />
      <text x="14" y="72" fontFamily="JetBrains Mono" fontSize="14" fill="#d6624d">
        $9.00
      </text>
      <circle cx="110" cy="34" r="10" fill="#d6624d" />
      <circle cx="100" cy="34" r="10" fill="#c8a45c" opacity="0.7" />
    </svg>
  );
}

function AuditVisual() {
  return (
    <svg viewBox="0 0 280 110" className="block w-full max-w-[280px] h-auto" aria-hidden>
      <g fontFamily="JetBrains Mono" fontSize="9" fill="#1a1f36">
        <text x="0" y="14">
          14:02 &middot; open &middot; oakridge/main
        </text>
        <text x="0" y="32">
          13:58 &middot; open &middot; oakridge/ped
        </text>
        <text x="0" y="50" fill="#d6624d">
          13:41 &middot; denied &middot; geofence
        </text>
        <text x="0" y="68">
          13:30 &middot; paired &middot; ACC-04
        </text>
      </g>
      <polyline
        points="0,100 30,90 60,82 90,86 120,72 150,76 180,60 210,68 240,52 270,56"
        fill="none"
        stroke="#1a1f36"
        strokeWidth="1.2"
      />
      <circle cx="180" cy="60" r="3" fill="#d6624d" />
    </svg>
  );
}
