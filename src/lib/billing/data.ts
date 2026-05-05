// Static reference data for the whatsacc billing model.
//
// All native pricing and costs are stored in ZAR. This module exposes:
//   - the supported display currencies (with FX-to-ZAR rates)
//   - the supported countries (with WhatsApp conversation cost in ZAR)
//   - small helpers to look up records and format amounts in any currency
//
// FX rates are seeded from late-2024 estimates. They are intended to be
// refreshed by a cron later; treat them as static placeholders for now.

export type CurrencyCode =
  | 'ZAR'
  | 'USD'
  | 'EUR'
  | 'GBP'
  | 'CAD'
  | 'AUD'
  | 'BRL'
  | 'MXN'
  | 'INR'
  | 'IDR'
  | 'PHP'
  | 'NGN'
  | 'KES'
  | 'AED';

export type Currency = {
  code: CurrencyCode;
  name: string;
  symbol: string;
  /** 1 unit of this currency = `fxToZar` ZAR. Display amount = zar / fxToZar. */
  fxToZar: number;
  /** Typical fractional digits for this currency (0 for IDR/NGN/INR/PHP). */
  decimals: number;
};

export type Country = {
  /** ISO 3166-1 alpha-2 code. */
  code: string;
  name: string;
  /** Flag emoji, e.g. "🇿🇦". */
  flag: string;
  currencyCode: CurrencyCode;
  /** WhatsApp business-initiated conversation cost in ZAR. */
  msgCostZar: number;
};

export const CURRENCIES: Currency[] = [
  { code: 'ZAR', name: 'South African Rand', symbol: 'R', fxToZar: 1.0, decimals: 2 },
  { code: 'USD', name: 'US Dollar', symbol: '$', fxToZar: 18.5, decimals: 2 },
  { code: 'EUR', name: 'Euro', symbol: '€', fxToZar: 20.0, decimals: 2 },
  { code: 'GBP', name: 'British Pound', symbol: '£', fxToZar: 24.0, decimals: 2 },
  { code: 'CAD', name: 'Canadian Dollar', symbol: 'C$', fxToZar: 13.5, decimals: 2 },
  { code: 'AUD', name: 'Australian Dollar', symbol: 'A$', fxToZar: 12.0, decimals: 2 },
  { code: 'BRL', name: 'Brazilian Real', symbol: 'R$', fxToZar: 3.2, decimals: 2 },
  { code: 'MXN', name: 'Mexican Peso', symbol: 'Mex$', fxToZar: 1.0, decimals: 2 },
  { code: 'INR', name: 'Indian Rupee', symbol: '₹', fxToZar: 0.22, decimals: 0 },
  { code: 'IDR', name: 'Indonesian Rupiah', symbol: 'Rp', fxToZar: 0.0012, decimals: 0 },
  { code: 'PHP', name: 'Philippine Peso', symbol: '₱', fxToZar: 0.32, decimals: 0 },
  { code: 'NGN', name: 'Nigerian Naira', symbol: '₦', fxToZar: 0.012, decimals: 0 },
  { code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', fxToZar: 0.14, decimals: 2 },
  { code: 'AED', name: 'UAE Dirham', symbol: 'د.إ', fxToZar: 5.0, decimals: 2 },
];

export const COUNTRIES: Country[] = [
  { code: 'ZA', name: 'South Africa', flag: '🇿🇦', currencyCode: 'ZAR', msgCostZar: 0.148 },
  { code: 'NG', name: 'Nigeria', flag: '🇳🇬', currencyCode: 'NGN', msgCostZar: 0.122 },
  { code: 'KE', name: 'Kenya', flag: '🇰🇪', currencyCode: 'KES', msgCostZar: 0.407 },
  { code: 'US', name: 'United States', flag: '🇺🇸', currencyCode: 'USD', msgCostZar: 0.463 },
  { code: 'CA', name: 'Canada', flag: '🇨🇦', currencyCode: 'CAD', msgCostZar: 0.463 },
  { code: 'BR', name: 'Brazil', flag: '🇧🇷', currencyCode: 'BRL', msgCostZar: 0.093 },
  { code: 'MX', name: 'Mexico', flag: '🇲🇽', currencyCode: 'MXN', msgCostZar: 0.113 },
  { code: 'GB', name: 'United Kingdom', flag: '🇬🇧', currencyCode: 'GBP', msgCostZar: 0.407 },
  { code: 'DE', name: 'Germany', flag: '🇩🇪', currencyCode: 'EUR', msgCostZar: 0.407 },
  { code: 'FR', name: 'France', flag: '🇫🇷', currencyCode: 'EUR', msgCostZar: 0.407 },
  { code: 'AE', name: 'UAE', flag: '🇦🇪', currencyCode: 'AED', msgCostZar: 0.352 },
  { code: 'IN', name: 'India', flag: '🇮🇳', currencyCode: 'INR', msgCostZar: 0.065 },
  { code: 'ID', name: 'Indonesia', flag: '🇮🇩', currencyCode: 'IDR', msgCostZar: 0.191 },
  { code: 'PH', name: 'Philippines', flag: '🇵🇭', currencyCode: 'PHP', msgCostZar: 0.178 },
  { code: 'AU', name: 'Australia', flag: '🇦🇺', currencyCode: 'AUD', msgCostZar: 0.507 },
];

const CURRENCY_BY_CODE: Record<CurrencyCode, Currency> = CURRENCIES.reduce(
  (acc, c) => {
    acc[c.code] = c;
    return acc;
  },
  {} as Record<CurrencyCode, Currency>,
);

const COUNTRY_BY_CODE: Record<string, Country> = COUNTRIES.reduce<Record<string, Country>>(
  (acc, c) => {
    acc[c.code] = c;
    return acc;
  },
  {},
);

export function getCurrency(code: CurrencyCode): Currency {
  const c = CURRENCY_BY_CODE[code];
  if (!c) {
    throw new Error(`Unknown currency: ${code}`);
  }
  return c;
}

export function getCountry(code: string): Country | undefined {
  return COUNTRY_BY_CODE[code.toUpperCase()];
}

/**
 * Format a ZAR amount as a string in the supplied display currency.
 *
 * Rules:
 *   - Convert via `zarAmount / currency.fxToZar`.
 *   - If the currency's natural decimals are 0 (IDR, NGN, INR, PHP), no fraction.
 *   - If the converted amount is >= 100, drop the fraction (round to integer)
 *     for cleanliness.
 *   - Otherwise use `currency.decimals` fractional digits.
 *
 * Uses `Intl.NumberFormat` with `style: 'currency'` so the user gets the
 * native symbol/positioning for their locale.
 */
export function formatCurrency(zarAmount: number, currency: Currency): string {
  const raw = zarAmount / currency.fxToZar;
  const useInteger = currency.decimals === 0 || Math.abs(raw) >= 100;
  const value = useInteger ? Math.round(raw) : raw;
  const fractionDigits = useInteger ? 0 : currency.decimals;

  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency.code,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(value);
  } catch {
    // Fallback for any environment that rejects the currency code.
    const num = new Intl.NumberFormat(undefined, {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(value);
    return `${currency.symbol} ${num}`;
  }
}
