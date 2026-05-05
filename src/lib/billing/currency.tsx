// React context for the visitor's display currency.
//
// The display currency is purely a UI preference — billing always happens in
// ZAR. We persist the choice to localStorage under `whatsacc.currency`, and
// default by sniffing `navigator.language` (e.g. en-ZA → ZAR, en-US → USD).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  CURRENCIES,
  formatCurrency,
  getCurrency,
  type Currency,
  type CurrencyCode,
} from './data';

const STORAGE_KEY = 'whatsacc.currency';

// Map of region (ISO 3166-1 alpha-2) → currency we support. Used to pick a
// sensible default from `navigator.language` on first visit.
const REGION_TO_CURRENCY: Record<string, CurrencyCode> = {
  ZA: 'ZAR',
  US: 'USD',
  CA: 'CAD',
  AU: 'AUD',
  GB: 'GBP',
  IE: 'EUR',
  DE: 'EUR',
  FR: 'EUR',
  ES: 'EUR',
  IT: 'EUR',
  NL: 'EUR',
  PT: 'EUR',
  BR: 'BRL',
  MX: 'MXN',
  IN: 'INR',
  ID: 'IDR',
  PH: 'PHP',
  NG: 'NGN',
  KE: 'KES',
  AE: 'AED',
};

const SUPPORTED: Set<CurrencyCode> = new Set(CURRENCIES.map((c) => c.code));

function isSupportedCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && SUPPORTED.has(value as CurrencyCode);
}

function detectInitialCurrency(): CurrencyCode {
  if (typeof window === 'undefined') return 'ZAR';

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isSupportedCurrencyCode(stored)) return stored;
  } catch {
    // localStorage may be unavailable (private mode, SSR-ish)
  }

  const lang = window.navigator?.language ?? '';
  // Pull region from things like "en-ZA" or "en-US-POSIX"
  const parts = lang.split('-');
  const region = parts[1]?.toUpperCase();
  if (region && REGION_TO_CURRENCY[region]) {
    return REGION_TO_CURRENCY[region];
  }

  return 'ZAR';
}

type CurrencyState = {
  currency: Currency;
  setCurrency: (code: CurrencyCode) => void;
};

const Ctx = createContext<CurrencyState | null>(null);

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [code, setCode] = useState<CurrencyCode>(() => detectInitialCurrency());

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, code);
    } catch {
      // ignore
    }
  }, [code]);

  const setCurrency = useCallback((c: CurrencyCode) => setCode(c), []);

  const value = useMemo<CurrencyState>(
    () => ({ currency: getCurrency(code), setCurrency }),
    [code, setCurrency],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCurrency(): CurrencyState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useCurrency must be used inside CurrencyProvider');
  return v;
}

/**
 * Returns a memoised formatter that converts a ZAR amount into the user's
 * currently-selected display currency, using `formatCurrency`.
 */
export function useFormatZar(): (zarAmount: number) => string {
  const { currency } = useCurrency();
  return useCallback((zar: number) => formatCurrency(zar, currency), [currency]);
}
