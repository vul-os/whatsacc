export function PeekInside() {
  return (
    <section className="relative bg-paper-warm">
      <div className="mx-auto max-w-[1280px] px-5 sm:px-6 lg:px-10 py-20 md:py-24">
        <div className="grid grid-cols-12 gap-x-8 gap-y-6 mb-10 md:mb-12">
          <div className="col-span-12 lg:col-span-5">
            <span className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-ink/55">
              <span className="h-1 w-1 rounded-full bg-terracotta" aria-hidden />
              A peek inside
            </span>
            <h2 className="mt-4 font-display-tight text-4xl sm:text-5xl lg:text-[56px] leading-[0.96] tracking-[-0.02em]">
              The control room <em className="italic text-terracotta">behind the gate.</em>
            </h2>
          </div>
          <div className="col-span-12 lg:col-span-6 lg:col-start-7">
            <p className="text-ink/70 leading-relaxed">
              Owners and managers see every event live. Filter by location, member or device.
              Replay a denied open and see exactly which check rejected it.
            </p>
          </div>
        </div>

        <div className="rounded-2xl sm:rounded-3xl bg-ink p-2 sm:p-3 shadow-[0_30px_80px_-30px_rgba(26,31,54,0.5)]">
          <div className="rounded-xl sm:rounded-2xl bg-paper overflow-hidden">
            <div className="flex items-center gap-2 px-4 sm:px-5 py-3 border-b border-ink/10">
              <span className="h-2.5 w-2.5 rounded-full bg-terracotta" />
              <span className="h-2.5 w-2.5 rounded-full bg-gold" />
              <span className="h-2.5 w-2.5 rounded-full bg-moss" />
              <span className="ml-3 text-[11px] sm:text-xs text-ink/45 font-mono truncate">
                app.whatsacc.io / oakridge
              </span>
            </div>

            <div className="grid grid-cols-12 md:min-h-[460px]">
              {/* left: chat transcript */}
              <div className="col-span-12 md:col-span-7 border-b md:border-b-0 md:border-r border-ink/10 p-5 sm:p-6 lg:p-8">
                <div className="flex items-center justify-between mb-4 gap-4">
                  <div className="min-w-0">
                    <p className="text-[11px] uppercase tracking-[0.18em] text-ink/45">Live</p>
                    <p className="font-display text-xl sm:text-2xl truncate">Oakridge &middot; Main gate</p>
                  </div>
                  <span className="inline-flex items-center gap-2 text-xs shrink-0">
                    <span className="relative h-2 w-2">
                      <span className="absolute inset-0 rounded-full bg-moss" />
                      <span className="absolute inset-[-3px] rounded-full bg-moss/30 signal-wave" />
                    </span>
                    Online
                  </span>
                </div>

                <ul className="space-y-3 mt-6">
                  <ChatLine who="Yusuf A." dir="in" time="14:02" body="open" />
                  <ChatLine dir="out" time="14:02" body="unlocked · 7s" verdict="ok" />
                  <ChatLine who="Nia M." dir="in" time="13:58" body="open" />
                  <ChatLine dir="out" time="13:58" body="unlocked · 7s" verdict="ok" />
                  <ChatLine who="+27 71 ••• 0192" dir="in" time="13:41" body="open" />
                  <ChatLine
                    dir="out"
                    time="13:41"
                    body="not opened — outside geofence (4.2km)"
                    verdict="block"
                  />
                </ul>
              </div>

              {/* right: stats */}
              <div className="col-span-12 md:col-span-5 p-5 sm:p-6 lg:p-8 bg-paper-cool/60">
                <p className="text-[11px] uppercase tracking-[0.18em] text-ink/45">Today</p>

                <div className="mt-4 grid grid-cols-2 gap-y-6 gap-x-4">
                  <Stat label="Opens" value="118" trend="+12" />
                  <Stat label="Denied" value="3" trend="-1" />
                  <Stat label="Avg time" value="1.8s" />
                  <Stat label="Members" value="124" />
                </div>

                <div className="mt-7">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-ink/45 mb-3">By hour</p>
                  <Chart />
                </div>

                <div className="mt-7">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-ink/45 mb-3">Devices</p>
                  <ul className="space-y-2 text-sm">
                    <DeviceRow name="ACC-01 · main" sig={92} />
                    <DeviceRow name="ACC-02 · ped" sig={88} />
                    <DeviceRow name="ACC-03 · park" sig={71} />
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ChatLine({
  who,
  dir,
  time,
  body,
  verdict,
}: {
  who?: string;
  dir: 'in' | 'out';
  time: string;
  body: string;
  verdict?: 'ok' | 'block';
}) {
  const isIn = dir === 'in';
  return (
    <li className={`flex ${isIn ? 'justify-start' : 'justify-end'}`}>
      <div className="max-w-[85%] sm:max-w-[80%]">
        {who && (
          <span className="text-[11px] text-ink/50 mb-1 block">
            {who} &middot; {time}
          </span>
        )}
        <div
          className={`px-3.5 py-2 rounded-2xl text-sm leading-snug ${
            isIn
              ? 'bg-paper-warm border border-ink/10 rounded-bl-md'
              : verdict === 'block'
                ? 'bg-terracotta/10 text-terracotta-deep border border-terracotta/30 rounded-br-md'
                : 'bg-ink text-paper rounded-br-md'
          }`}
        >
          {body}
        </div>
        {!who && (
          <span className="text-[11px] text-ink/40 block text-right mt-1">{time}</span>
        )}
      </div>
    </li>
  );
}

function Stat({ label, value, trend }: { label: string; value: string; trend?: string }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-[0.18em] text-ink/45">{label}</p>
      <p className="font-display text-3xl mt-1 leading-none">{value}</p>
      {trend && <p className="text-xs text-ink/55 mt-1">{trend} vs yesterday</p>}
    </div>
  );
}

function Chart() {
  const data = [4, 6, 3, 5, 8, 12, 18, 14, 11, 9, 7, 5];
  const max = Math.max(...data);
  return (
    <div className="flex items-end gap-1 h-20">
      {data.map((d, i) => (
        <span
          key={i}
          className="flex-1 rounded-sm bg-ink/80"
          style={{ height: `${(d / max) * 100}%`, opacity: 0.45 + (d / max) * 0.55 }}
        />
      ))}
    </div>
  );
}

function DeviceRow({ name, sig }: { name: string; sig: number }) {
  return (
    <li className="flex items-center gap-3">
      <span className="font-mono text-xs flex-1 truncate">{name}</span>
      <span className="h-1.5 w-16 sm:w-20 bg-ink/10 rounded-full overflow-hidden shrink-0">
        <span className="block h-full bg-moss" style={{ width: `${sig}%` }} />
      </span>
      <span className="text-xs text-ink/55 w-8 text-right shrink-0">{sig}%</span>
    </li>
  );
}
