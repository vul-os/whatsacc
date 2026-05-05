// Referral slug helpers.
//
// Format: 3-30 chars, lowercase a-z/0-9/hyphen, must start and end alphanumeric,
// no consecutive hyphens. Reserved list blocks system paths.

const ALLOWED = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
const NO_DOUBLE_HYPHEN = /^(?!.*--).*$/;

export const RESERVED_SLUGS = new Set<string>([
  'admin', 'administrator', 'api', 'app', 'apps', 'assets', 'auth', 'authentication',
  'billing', 'callback', 'dashboard', 'docs', 'help', 'home', 'login', 'logout',
  'me', 'oauth', 'password', 'pay', 'paystack', 'payout', 'pricing', 'privacy',
  'profile', 'r', 'referral', 'referrals', 'register', 'reset', 'root', 'security',
  'settings', 'signin', 'signup', 'static', 'support', 'system', 'terms', 'user',
  'users', 'verify', 'webhook', 'webhooks', 'whatsacc', 'whatsapp', 'www',
]);

export function isValidSlug(slug: string): boolean {
  if (typeof slug !== 'string') return false;
  if (!ALLOWED.test(slug)) return false;
  if (!NO_DOUBLE_HYPHEN.test(slug)) return false;
  if (RESERVED_SLUGS.has(slug)) return false;
  return true;
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function randomSlug(length = 8): string {
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  let s = '';
  for (let i = 0; i < length; i++) {
    s += ALPHABET[buf[i]! % ALPHABET.length];
  }
  return s;
}
