import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { LinkButton } from '@/components/ui/Button';
import { useCurrency } from '@/lib/billing/currency';
import { COUNTRIES, formatCurrency, getCountry, type Country } from '@/lib/billing/data';
import { estimate } from '@/lib/billing/estimate';
import { cn } from '@/lib/cn';

// Resident slider snaps. Keeps the curve sensible across both small homes
// and large complexes without giving false precision in the middle range.
const RESIDENT_STOPS = [10, 25, 50, 100, 200, 500, 1000, 2500, 5000] as const;

const DEFAULT_COUNTRY_CODE = 'ZA';
const DEFAULT_RESIDENTS = 200;
const DEFAULT_ACCESS_POINTS = 4;
const DEFAULT_OPENS_PER_DAY = 2;

function nearestResidentStop(value: number): number {
  let best: number = RESIDENT_STOPS[0];
  let bestDiff = Math.abs(value - best);
  for (const s of RESIDENT_STOPS) {
    const d = Math.abs(value - s);
    if (d < bestDiff) {
      best = s;
      bestDiff = d;
    }
  }
  return best;
}

function residentsFromIndex(idx: number): number {
  return RESIDENT_STOPS[idx] ?? RESIDENT_STOPS[0];
}

function indexFromResidents(value: number): number {
  const snapped = nearestResidentStop(value);
  const idx = (RESIDENT_STOPS as readonly number[]).indexOf(snapped);
  return idx === -1 ? 0 : idx;
}

function CountryPicker({
  value,
  onChange,
}: {
  value: Country;
  onChange: (c: Country) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return COUNTRIES;
    return COUNTRIES.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.code.toLowerCase().includes(q) ||
        c.currencyCode.toLowerCase().includes(q),
    );
  }, [query]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        onClick={() => {
          setOpen((v) => !v);
          setQuery('');
        }}
        className={cn(
          'flex w-full items-center justify-between gap-3 rounded-2xl border border-ink/15 bg-paper px-4 py-3 text-left transition-colors',
          'hover:border-ink/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink',
        )}
      >
        <span className="flex items-center gap-3">
          <span aria-hidden className="text-xl leading-none">
            {value.flag}
          </span>
          <span className="flex flex-col">
            <span className="font-display text-lg leading-tight">{value.name}</span>
            <span className="text-xs text-ink/55">
              WhatsApp · {value.currencyCode} · ~R {value.msgCostZar.toFixed(3)} per msg
            </span>
          </span>
        </span>
        <svg
          viewBox="0 0 12 12"
          aria-hidden
          className={cn('h-3 w-3 text-ink/45 transition-transform', open && 'rotate-180')}
        >
          <path
            d="M2 4.5 L6 8.5 L10 4.5"
            stroke="currentColor"
            strokeWidth="1.4"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <div
          id={listboxId}
          role="listbox"
          aria-label="Operating country"
          className="absolute left-0 right-0 z-30 mt-2 max-h-[60vh] overflow-hidden rounded-2xl border border-ink/10 bg-paper p-2 shadow-lg"
        >
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search country…"
            className="mb-2 w-full rounded-xl border border-ink/10 bg-paper-cool px-3 py-2 text-sm focus:border-ink/30 focus:outline-none"
          />
          <ul className="max-h-72 overflow-y-auto">
            {filtered.map((c) => {
              const selected = c.code === value.code;
              return (
                <li key={c.code}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      onChange(c);
                      setOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors',
                      selected ? 'bg-paper-warm text-ink' : 'text-ink/80 hover:bg-paper-cool',
                    )}
                  >
                    <span aria-hidden className="text-base leading-none">
                      {c.flag}
                    </span>
                    <span className="font-medium">{c.name}</span>
                    <span className="ml-auto text-xs uppercase tracking-[0.16em] text-ink/45">
                      {c.currencyCode}
                    </span>
                  </button>
                </li>
              );
            })}
            {filtered.length === 0 && (
              <li className="px-3 py-3 text-sm text-ink/55">No matches.</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

function Slider({
  label,
  value,
  display,
  min,
  max,
  step,
  onChange,
  legendLeft,
  legendRight,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  legendLeft: string;
  legendRight: string;
}) {
  const id = useId();
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <label htmlFor={id} className="text-[11px] uppercase tracking-[0.22em] text-ink/55">
          {label}
        </label>
        <span className="font-display text-2xl tabular-nums">{display}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className={cn(
          'mt-3 w-full appearance-none bg-transparent',
          // Track + thumb styled via arbitrary selectors
          '[&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-full',
          '[&::-webkit-slider-runnable-track]:bg-ink/15',
          '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:w-5',
          '[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-terracotta',
          '[&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-paper',
          '[&::-webkit-slider-thumb]:shadow-[0_2px_8px_rgba(0,0,0,0.18)]',
          '[&::-webkit-slider-thumb]:-mt-2 [&::-webkit-slider-thumb]:cursor-pointer',
          '[&::-moz-range-track]:h-1 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-ink/15',
          '[&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:rounded-full',
          '[&::-moz-range-thumb]:bg-terracotta [&::-moz-range-thumb]:border-2',
          '[&::-moz-range-thumb]:border-paper [&::-moz-range-thumb]:cursor-pointer',
          'focus-visible:outline-none',
        )}
      />
      <div className="mt-2 flex justify-between text-[11px] uppercase tracking-[0.18em] text-ink/45 tabular-nums">
        <span>{legendLeft}</span>
        <span>{legendRight}</span>
      </div>
    </div>
  );
}

function fmt(value: number, currency: Parameters<typeof formatCurrency>[1]) {
  return formatCurrency(value, currency);
}

export function PricingEstimator() {
  const { currency } = useCurrency();

  const [countryCode, setCountryCode] = useState<string>(DEFAULT_COUNTRY_CODE);
  const [residents, setResidents] = useState<number>(DEFAULT_RESIDENTS);
  const [accessPoints, setAccessPoints] = useState<number>(DEFAULT_ACCESS_POINTS);

  const country = useMemo(
    () => getCountry(countryCode) ?? COUNTRIES[0],
    [countryCode],
  );

  const baseEstimate = useMemo(
    () =>
      estimate({
        country,
        residents,
        accessPoints,
        opensPerDay: DEFAULT_OPENS_PER_DAY,
      }),
    [country, residents, accessPoints],
  );

  // Pre-compute every country's total at the current slider settings, sorted
  // alphabetically. This is the "open list of pricing for different countries".
  const countryRows = useMemo(() => {
    return COUNTRIES.map((c) => {
      const e = estimate({
        country: c,
        residents,
        accessPoints,
        opensPerDay: DEFAULT_OPENS_PER_DAY,
      });
      return { country: c, estimate: e };
    }).sort((a, b) => a.country.name.localeCompare(b.country.name));
  }, [residents, accessPoints]);

  const residentsIdx = indexFromResidents(residents);

  return (
    <section className="relative">
      <div className="mx-auto max-w-[1280px] px-5 sm:px-6 lg:px-10 pb-12 md:pb-16">
        <div className="rounded-3xl border border-ink/10 bg-paper-cool overflow-hidden">
          <div className="grid grid-cols-12 gap-x-8 gap-y-10 p-7 sm:p-10 lg:p-14">
            {/* Header */}
            <div className="col-span-12 grid grid-cols-12 gap-x-8 gap-y-3 items-end border-b border-ink/10 pb-8">
              <div className="col-span-12 lg:col-span-7">
                <span className="text-[11px] uppercase tracking-[0.22em] text-ink/55">
                  Estimate
                </span>
                <h2 className="mt-3 font-display-tight text-3xl sm:text-4xl lg:text-5xl leading-[0.95]">
                  Tell us your gate.
                  <br />
                  We&rsquo;ll <em className="italic text-terracotta">tell you the bill</em>.
                </h2>
              </div>
              <p className="col-span-12 lg:col-span-5 text-ink/65 leading-relaxed text-sm">
                Pick where you operate. Drag your residents and access points. The price below
                updates in your selected currency &mdash; change it any time from the top bar.
              </p>
            </div>

            {/* Inputs (left) + Breakdown (right) */}
            <div className="col-span-12 lg:col-span-7 flex flex-col gap-8">
              <div>
                <p className="text-[11px] uppercase tracking-[0.22em] text-ink/55 mb-3">
                  Where you operate
                </p>
                <CountryPicker
                  value={country}
                  onChange={(c) => setCountryCode(c.code)}
                />
              </div>

              <Slider
                label="Residents"
                value={residentsIdx}
                display={residents.toLocaleString()}
                min={0}
                max={RESIDENT_STOPS.length - 1}
                step={1}
                onChange={(idx) => setResidents(residentsFromIndex(idx))}
                legendLeft="10"
                legendRight="5,000"
              />

              <Slider
                label="Access points"
                value={accessPoints}
                display={String(accessPoints)}
                min={1}
                max={20}
                step={1}
                onChange={setAccessPoints}
                legendLeft="1"
                legendRight="20"
              />

              <p className="text-xs text-ink/50 leading-relaxed">
                We assume {DEFAULT_OPENS_PER_DAY} entries per resident per day &mdash; that&rsquo;s
                a typical complex. Heavy traffic? Talk to us, we&rsquo;ll size it together.
              </p>
            </div>

            <div className="col-span-12 lg:col-span-5">
              <div className="rounded-2xl bg-paper border border-ink/10 p-7 sm:p-8 flex flex-col h-full">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] uppercase tracking-[0.22em] text-ink/55">
                    Your property
                  </span>
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-paper-warm px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] text-ink/70">
                    {baseEstimate.plan}
                  </span>
                </div>

                <div className="mt-5">
                  <div className="font-display text-5xl sm:text-6xl tabular-nums leading-none">
                    {fmt(baseEstimate.totalZar, currency)}
                  </div>
                  <div className="mt-2 text-ink/55 text-sm">
                    per month &middot; about{' '}
                    <span className="text-ink/85">
                      {fmt(baseEstimate.perResidentZar, currency)}
                    </span>{' '}
                    per resident
                  </div>
                </div>

                <dl className="mt-7 space-y-3 text-sm">
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink/65">Subscription</dt>
                    <dd className="tabular-nums text-ink/90">
                      {fmt(baseEstimate.planPriceZar, currency)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink/65">
                      Extra access points
                      <span className="ml-2 text-ink/40">
                        {Math.max(0, accessPoints - 5)} &times; {fmt(49, currency)}
                      </span>
                    </dt>
                    <dd className="tabular-nums text-ink/90">
                      {fmt(baseEstimate.extraDevicesZar, currency)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink/65">
                      WhatsApp messages
                      <span className="ml-2 text-ink/40">
                        {baseEstimate.billableConversations.toLocaleString()} billable
                      </span>
                    </dt>
                    <dd className="tabular-nums text-ink/90">
                      {fmt(baseEstimate.msgCostZar, currency)}
                    </dd>
                  </div>
                  <div className="border-t border-ink/10 pt-3 flex justify-between gap-3 font-display text-lg">
                    <dt>Total</dt>
                    <dd className="tabular-nums">{fmt(baseEstimate.totalZar, currency)}</dd>
                  </div>
                </dl>

                <div className="mt-7 flex flex-col sm:flex-row gap-3">
                  <LinkButton to="/signup" variant="ink" size="md" className="flex-1">
                    Start free trial
                  </LinkButton>
                  <LinkButton
                    to="/signup"
                    variant="outline"
                    size="md"
                    className="flex-1"
                  >
                    Talk to sales &rarr;
                  </LinkButton>
                </div>

                <p className="mt-4 text-[11px] text-ink/45 leading-relaxed">
                  Shown in {currency.code}. Billing is in ZAR &mdash; FX is for display only.
                </p>
              </div>
            </div>

            {/* Country comparison */}
            <div className="col-span-12 border-t border-ink/10 pt-10">
              <div className="flex items-end justify-between gap-4 mb-6 flex-wrap">
                <div>
                  <span className="text-[11px] uppercase tracking-[0.22em] text-ink/55">
                    Prices by country
                  </span>
                  <h3 className="mt-2 font-display-tight text-2xl sm:text-3xl">
                    Same setup, different markets.
                  </h3>
                </div>
                <p className="text-sm text-ink/55 tabular-nums">
                  {residents.toLocaleString()} residents &middot; {accessPoints} gate
                  {accessPoints === 1 ? '' : 's'}
                </p>
              </div>

              <div className="rounded-2xl border border-ink/10 overflow-hidden bg-paper">
                <ul role="list">
                  {countryRows.map(({ country: c, estimate: e }, i) => {
                    const isSelected = c.code === country.code;
                    return (
                      <li
                        key={c.code}
                        className={cn(
                          'flex items-center gap-4 px-5 py-3.5 text-sm transition-colors',
                          i > 0 && 'border-t border-ink/10',
                          isSelected ? 'bg-paper-warm' : 'hover:bg-paper-cool',
                        )}
                      >
                        <span aria-hidden className="text-lg leading-none w-6 text-center">
                          {c.flag}
                        </span>
                        <span className="font-medium text-ink/90 min-w-[10rem]">
                          {c.name}
                        </span>
                        <span className="text-[11px] uppercase tracking-[0.18em] text-ink/45">
                          {c.currencyCode}
                        </span>
                        <span className="ml-auto font-display text-lg tabular-nums">
                          {fmt(e.totalZar, currency)}
                        </span>
                        <span className="hidden sm:inline-block w-20 text-right text-xs text-ink/50 tabular-nums">
                          {fmt(e.perResidentZar, currency)}
                          <span className="ml-1 text-ink/35">/res</span>
                        </span>
                        {isSelected && (
                          <span className="hidden md:inline-flex items-center text-[10px] uppercase tracking-[0.2em] text-terracotta">
                            selected
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>

              <p className="mt-4 text-xs text-ink/45 leading-relaxed">
                Differences come from Meta&rsquo;s WhatsApp conversation rate per country. Plan
                price is identical worldwide.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
