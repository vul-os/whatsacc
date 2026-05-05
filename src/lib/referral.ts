// Persistent referral attribution on the client.
//
// `/r/:slug` resolves the slug, stores it here, then redirects to /signup.
// Signup reads it on submit and includes it in the registration body.

const COOKIE_KEY = 'whatsacc_ref';
const STORAGE_KEY = 'whatsacc.ref';
const TTL_DAYS = 90;

export function setReferral(slug: string, displayName: string | null = null): void {
  const value = JSON.stringify({ slug, displayName, savedAt: new Date().toISOString() });
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // ignore
  }
  const expires = new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000).toUTCString();
  document.cookie = `${COOKIE_KEY}=${encodeURIComponent(slug)}; path=/; expires=${expires}; SameSite=Lax`;
}

export function getReferral(): { slug: string; displayName: string | null } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { slug?: string; displayName?: string | null };
      if (parsed.slug && typeof parsed.slug === 'string') {
        return { slug: parsed.slug, displayName: parsed.displayName ?? null };
      }
    }
  } catch {
    // fall through
  }
  const m = document.cookie.match(new RegExp(`(?:^|; )${COOKIE_KEY}=([^;]*)`));
  if (m) {
    return { slug: decodeURIComponent(m[1]!), displayName: null };
  }
  return null;
}

export function clearReferral(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  document.cookie = `${COOKIE_KEY}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax`;
}
