import { useState, useRef, useCallback, useEffect } from 'react';

const TOKEN = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_MAPBOX_TOKEN ?? '';

// SA-targeted geocoding: country filter narrows the corpus server-side and
// proximity=ip biases ranking toward the requester. en-ZA uses local place
// names (e.g. "Newlands" without USA disambiguation suffixes).
const GEOCODE_COUNTRY = 'za';
const GEOCODE_LANG = 'en-ZA';

type GeoFeature = {
  id: string;
  place_name: string;
  center: [number, number]; // [lng, lat]
  context?: Array<{ id: string; text: string }>;
};

export type SelectedAddress = {
  full_address: string;
  city: string | null;
  country: string | null;
  lat: number;
  long: number;
};

export function MapboxAddressInput({
  value,
  onChange,
  required,
}: {
  value: SelectedAddress | null;
  onChange: (v: SelectedAddress | null) => void;
  required?: boolean;
}) {
  const [query, setQuery] = useState(value?.full_address ?? '');
  const [suggestions, setSuggestions] = useState<GeoFeature[]>([]);
  const [open, setOpen] = useState(false);
  const [fetching, setFetching] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Cancel any in-flight geocode when the user keeps typing — without this
  // a slow request can overwrite the response from a newer keystroke.
  const inflight = useRef<AbortController | null>(null);

  const search = useCallback(async (q: string) => {
    if (!TOKEN || q.length < 3) { setSuggestions([]); setOpen(false); return; }
    inflight.current?.abort();
    const ctl = new AbortController();
    inflight.current = ctl;
    setFetching(true);
    try {
      const params = new URLSearchParams({
        access_token: TOKEN,
        types: 'address',
        limit: '5',
        language: GEOCODE_LANG,
        country: GEOCODE_COUNTRY,
        proximity: 'ip',
        autocomplete: 'true',
      });
      const url =
        `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?${params.toString()}`;
      const res = await fetch(url, { signal: ctl.signal });
      const data = (await res.json()) as { features: GeoFeature[] };
      // Only commit results if this is still the latest request.
      if (inflight.current === ctl) {
        setSuggestions(data.features ?? []);
        setOpen((data.features ?? []).length > 0);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setSuggestions([]);
    } finally {
      if (inflight.current === ctl) setFetching(false);
    }
  }, []);

  // Drop any pending request when the component unmounts so we don't update
  // state on an unmounted node.
  useEffect(() => () => inflight.current?.abort(), []);

  function onInput(e: React.ChangeEvent<HTMLInputElement>) {
    const q = e.target.value;
    setQuery(q);
    if (value) onChange(null);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => search(q), 220);
  }

  function select(f: GeoFeature) {
    const [lng, lat] = f.center;
    const city = f.context?.find((c) => c.id.startsWith('place'))?.text ?? null;
    const country = f.context?.find((c) => c.id.startsWith('country'))?.text ?? null;
    onChange({ full_address: f.place_name, city, country, lat, long: lng });
    setQuery(f.place_name);
    setSuggestions([]);
    setOpen(false);
  }

  function clear() {
    onChange(null);
    setQuery('');
    setSuggestions([]);
    setOpen(false);
  }

  function onBlur(e: React.FocusEvent) {
    if (containerRef.current?.contains(e.relatedTarget as Node)) return;
    setOpen(false);
  }

  const staticMapUrl = value
    ? `https://api.mapbox.com/styles/v1/mapbox/dark-v11/static/` +
      `pin-s+d6624d(${value.long},${value.lat})/` +
      `${value.long},${value.lat},14/` +
      `600x220@2x?access_token=${TOKEN}`
    : null;

  if (!TOKEN) {
    return (
      <div className="rounded-xl border border-terracotta/30 bg-paper-warm px-4 py-3 text-sm text-ink/65">
        Add <code className="text-xs bg-ink/8 px-1 py-0.5 rounded">VITE_MAPBOX_TOKEN</code> to your{' '}
        <code className="text-xs bg-ink/8 px-1 py-0.5 rounded">.env</code> to enable address search.
      </div>
    );
  }

  return (
    <div ref={containerRef} className="space-y-3" onBlur={onBlur}>
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={onInput}
          onFocus={() => suggestions.length > 0 && setOpen(true)}
          placeholder="Search full address…"
          autoComplete="off"
          required={required && !value}
          className="w-full h-11 rounded-xl bg-paper-cool border border-ink/15 px-4 pr-10 text-[15px] focus:outline-none focus:ring-2 focus:ring-ink"
        />
        {value ? (
          <button
            type="button"
            onClick={clear}
            aria-label="Clear address"
            className="absolute right-3 top-1/2 -translate-y-1/2 text-ink/35 hover:text-ink text-lg leading-none"
          >
            ×
          </button>
        ) : fetching ? (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-ink/35 text-xs">…</span>
        ) : null}

        {open && suggestions.length > 0 && (
          <ul className="absolute z-50 mt-1 w-full bg-paper border border-ink/10 rounded-xl shadow-xl overflow-hidden">
            {suggestions.map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => select(f)}
                  className="w-full text-left px-4 py-3 text-sm hover:bg-paper-cool border-b border-ink/5 last:border-0"
                >
                  <span className="font-medium text-ink">
                    {f.place_name.split(',')[0]}
                  </span>
                  <span className="text-ink/50 text-xs ml-1">
                    {f.place_name.split(',').slice(1).join(',').trim()}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {staticMapUrl && value && (
        <div className="rounded-xl overflow-hidden border border-ink/10">
          <img
            src={staticMapUrl}
            alt={`Map of ${value.full_address}`}
            className="w-full block"
            style={{ height: '160px', objectFit: 'cover' }}
          />
          <div className="px-3 py-2 bg-ink/5 text-xs text-ink/60 truncate">
            {value.full_address}
          </div>
        </div>
      )}
    </div>
  );
}
