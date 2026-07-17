// Region & tier definitions, derived from billing-model/generate.py.
// Re-run `python3 billing-model/generate.py` and reconcile this file when the
// underlying assumptions change. The model's `out/tiers.json` is the source
// of truth; the values below are extracted from a known-good run.

export type RegionCode = 'us-ca' | 'eu-west' | 'za' | 'latam' | 'in-sea';

export type TierCode = 'free' | 'basic' | 'starter' | 'growth' | 'business' | 'scale';

export interface Tier {
  code: TierCode;
  name: string;
  /** Price in the region's local currency. 0 for Free. */
  priceLocal: number;
  /** Approximate USD-equivalent at modelling time — for cross-region comparison only. */
  priceUsd: number;
  /** Max active residents linked to this account. */
  residents: number;
  /** Max controller devices (gates) provisioned. */
  devices: number;
  /** Max distinct locations. */
  locations: number;
  /** Combined WhatsApp + web-portal opens included per billing month. */
  opensPerMonth: number;
  /** Web portal access — always true; web portal is unlimited and is the headline feature. */
  webPortal: true;
  blurb: string;
}

export interface Region {
  code: RegionCode;
  name: string;
  countries: readonly string[];
  currency: string;
  /** Local-currency multiplier to convert to USD (~ for analytics; not for billing). */
  fxToUsd: number;
  /** Pay-as-you-go price per WhatsApp open above tier cap, in local currency. */
  paygOpenPriceLocal: number;
  tiers: readonly Tier[];
}

const COMMON_TIER_SHAPE = [
  { code: 'free' as const,     name: 'Free',     residents:    5, devices:  1, locations:  1, opensPerMonth:   100, blurb: 'Try it. Web portal access included.' },
  { code: 'basic' as const,    name: 'Basic',    residents:   20, devices:  2, locations:  1, opensPerMonth:   300, blurb: 'One location, essentials included.' },
  { code: 'starter' as const,  name: 'Starter',  residents:   30, devices:  3, locations:  1, opensPerMonth:   900, blurb: 'For a single estate or building.' },
  { code: 'growth' as const,   name: 'Growth',   residents:  100, devices:  8, locations:  2, opensPerMonth:  3000, blurb: 'Most popular — small estate.' },
  { code: 'business' as const, name: 'Business', residents:  300, devices: 20, locations:  5, opensPerMonth:  9000, blurb: 'Multi-site or large estate.' },
  { code: 'scale' as const,    name: 'Scale',    residents: 1000, devices: 60, locations: 15, opensPerMonth: 30000, blurb: 'Enterprise estates / property mgmt.' },
];

// Per-region pricing (local currency) and FX. Prices come from
// billing-model/out/tiers.json — the model verifies each price clears the
// margin floor for that region's WhatsApp / Paystack costs.
const REGION_PRICING = {
  'us-ca': {
    name: 'US / Canada',
    countries: ['US', 'CA'] as const,
    currency: 'USD',
    fxToUsd: 1.0,
    paygOpenPriceLocal: 0.10,
    prices: { free: 0, basic: 9.99, starter: 38.99, growth: 99.00, business: 249.00, scale: 699.00 },
  },
  'eu-west': {
    name: 'Western Europe',
    countries: ['GB', 'DE', 'FR', 'NL', 'ES', 'IT', 'IE', 'PT'] as const,
    currency: 'EUR',
    fxToUsd: 1.08,
    paygOpenPriceLocal: 0.08,
    prices: { free: 0, basic: 8.99, starter: 31.99, growth: 82.99, business: 209.00, scale: 579.00 },
  },
  'za': {
    name: 'South Africa',
    countries: ['ZA'] as const,
    currency: 'ZAR',
    fxToUsd: 0.054,
    paygOpenPriceLocal: 1.50,
    prices: { free: 0, basic: 99.99, starter: 349, growth: 899, business: 2299, scale: 6299 },
  },
  'latam': {
    name: 'Brazil / LATAM',
    countries: ['BR', 'MX', 'AR', 'CO', 'CL'] as const,
    currency: 'USD',
    fxToUsd: 1.0,
    paygOpenPriceLocal: 0.04,
    prices: { free: 0, basic: 4.99, starter: 14.99, growth: 38.99, business: 97.99, scale: 269.00 },
  },
  'in-sea': {
    name: 'India / SE Asia',
    countries: ['IN', 'ID', 'PH', 'VN', 'MY', 'TH'] as const,
    currency: 'USD',
    fxToUsd: 1.0,
    paygOpenPriceLocal: 0.03,
    prices: { free: 0, basic: 3.99, starter: 11.99, growth: 30.99, business: 77.99, scale: 219.00 },
  },
} as const;

function buildRegion(code: RegionCode): Region {
  const r = REGION_PRICING[code];
  const tiers: Tier[] = COMMON_TIER_SHAPE.map(shape => {
    const priceLocal = r.prices[shape.code];
    return {
      ...shape,
      priceLocal,
      priceUsd: priceLocal * r.fxToUsd,
      webPortal: true,
    };
  });
  return {
    code,
    name: r.name,
    countries: r.countries,
    currency: r.currency,
    fxToUsd: r.fxToUsd,
    paygOpenPriceLocal: r.paygOpenPriceLocal,
    tiers,
  };
}

export const REGIONS: Readonly<Record<RegionCode, Region>> = Object.freeze({
  'us-ca': buildRegion('us-ca'),
  'eu-west': buildRegion('eu-west'),
  'za': buildRegion('za'),
  'latam': buildRegion('latam'),
  'in-sea': buildRegion('in-sea'),
});

export const REGION_CODES: readonly RegionCode[] = Object.freeze(
  ['us-ca', 'eu-west', 'za', 'latam', 'in-sea'],
);

const COUNTRY_TO_REGION: Readonly<Record<string, RegionCode>> = (() => {
  const map: Record<string, RegionCode> = {};
  for (const code of REGION_CODES) {
    for (const country of REGIONS[code].countries) map[country] = code;
  }
  return Object.freeze(map);
})();

/** Resolve an ISO 3166-1 alpha-2 country code to a region. Falls back to us-ca. */
export function regionForCountry(country: string | null | undefined): RegionCode {
  if (!country) return 'us-ca';
  return COUNTRY_TO_REGION[country.toUpperCase()] ?? 'us-ca';
}

export function tier(region: RegionCode, code: TierCode): Tier {
  const t = REGIONS[region].tiers.find(t => t.code === code);
  if (!t) throw new Error(`unknown tier ${code} in region ${region}`);
  return t;
}

/**
 * Convert a local-currency price to integer minor units (cents / lowest
 * subunit). ZAR & USD & EUR all have 2 decimal places.
 */
export function priceMinorUnits(amount: number): number {
  return Math.round(amount * 100);
}
