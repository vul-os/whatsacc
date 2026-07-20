// Runtime gateway selection.
//
// The portal historically baked the backend origin in at build time via
// VITE_API_BASE_URL. The desktop (Tauri) build must be able to connect to ANY
// lintel gateway, so the effective base URL is now resolved at call time:
//
//   1. localStorage 'lintel.gateway_url'  — the user's explicit choice
//   2. VITE_API_BASE_URL                    — build-time default (web deploys)
//   3. http://localhost:8787                — bare dev fallback
//
// In plain web-serving mode nothing changes unless the user explicitly picks a
// gateway (via the picker / ?gateway= deep link) — until then key (1) is unset.
//
// This module must stay dependency-free of api.ts (api.ts imports us).

export const GATEWAY_KEY = 'lintel.gateway_url';

const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};

/** Build-time base URL, or null when the build wasn't configured with one. */
export function envBaseUrl(): string | null {
  const v = env.VITE_API_BASE_URL;
  return v ? v.replace(/\/+$/, '') : null;
}

/** Base URL used when nothing else is configured (bare `npm run dev`). */
export const FALLBACK_BASE_URL = 'http://localhost:8787';

/** True when running inside the Tauri desktop shell. */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** The user's explicitly-chosen gateway, or null. */
export function getStoredGatewayUrl(): string | null {
  try {
    return window.localStorage.getItem(GATEWAY_KEY);
  } catch {
    return null;
  }
}

/** Effective API base URL — stored gateway, else build-time env, else localhost. */
export function getApiBaseUrl(): string {
  const stored = getStoredGatewayUrl();
  if (stored) return stored.replace(/\/+$/, '');
  return envBaseUrl() ?? FALLBACK_BASE_URL;
}

/**
 * Normalize user input into a canonical base URL:
 * - trims, prepends https:// when no scheme was typed
 * - only http(s) allowed
 * - drops query/hash, strips trailing slashes
 * Returns null when the input can't be a gateway URL.
 */
export function normalizeGatewayUrl(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!u.hostname) return null;
  u.hash = '';
  u.search = '';
  u.username = '';
  u.password = '';
  return u.toString().replace(/\/+$/, '');
}

// ── fetch that works from the desktop shell ────────────────────────────────
//
// Gateways run a strict CORS allowlist (localhost + known web origins). The
// Tauri webview's origin (tauri://localhost) is never on it, so inside Tauri
// we route requests through @tauri-apps/plugin-http — a native (reqwest)
// fetch that isn't subject to CORS. Outside Tauri this is window.fetch.

type NativeFetch = { fetch: typeof fetch; native: boolean };

let tauriFetchPromise: Promise<NativeFetch> | null = null;

function loadTauriFetch(): Promise<NativeFetch> {
  if (!tauriFetchPromise) {
    tauriFetchPromise = import('@tauri-apps/plugin-http')
      .then((m) => ({ fetch: m.fetch as typeof fetch, native: true }))
      .catch(() => ({ fetch: window.fetch.bind(window), native: false }));
  }
  return tauriFetchPromise;
}

export async function gatewayFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  if (isTauri()) {
    const f = await loadTauriFetch();
    try {
      return await f.fetch(input, init);
    } catch (err) {
      // A thrown error is plugin/network level (HTTP errors come back as
      // Response objects). Retry once through the webview's own fetch —
      // useless against CORS-strict gateways, but it keeps a broken plugin
      // setup from bricking every request. Never retry an aborted request.
      if (!f.native || init?.signal?.aborted) throw err;
      console.warn('lintel: native fetch failed, retrying via webview fetch', err);
      return fetch(input, init);
    }
  }
  return fetch(input, init);
}

// ── health probe ───────────────────────────────────────────────────────────

export type GatewayTestResult =
  | { ok: true; env?: string }
  | { ok: false; message: string };

/** GET <base>/health and interpret the response. Never throws. */
export async function testGatewayUrl(baseUrl: string, timeoutMs = 8000): Promise<GatewayTestResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await gatewayFetch(`${baseUrl}/health`, {
      method: 'GET',
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return { ok: false, message: `The gateway responded with HTTP ${res.status}.` };
    const j = (await res.json().catch(() => null)) as { ok?: boolean; env?: string } | null;
    if (j && j.ok === false) {
      return { ok: false, message: 'The gateway is up but reports an unhealthy database.' };
    }
    return { ok: true, env: j?.env };
  } catch {
    return {
      ok: false,
      message: ctrl.signal.aborted
        ? 'Timed out — no answer from that address.'
        : 'Could not reach that address. Check the URL (and that the gateway allows this origin).',
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── applying a change ──────────────────────────────────────────────────────

/**
 * Tokens/caches belong to the gateway that minted them. When the effective
 * base URL changes, drop every lintel.* key except the gateway choice
 * itself and the theme.
 */
function clearPerGatewayState(): void {
  const keep = new Set([GATEWAY_KEY, 'lintel.theme']);
  try {
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith('lintel.') && !keep.has(k)) window.localStorage.removeItem(k);
    }
  } catch {
    /* storage unavailable — nothing to clear */
  }
}

/**
 * Persist (or clear, with null) the chosen gateway and reboot the app on it.
 * Session state is wiped only when the effective base URL actually changes.
 */
export function applyGatewayUrl(url: string | null): void {
  const prev = getApiBaseUrl();
  try {
    if (url) window.localStorage.setItem(GATEWAY_KEY, url);
    else window.localStorage.removeItem(GATEWAY_KEY);
  } catch {
    /* storage unavailable */
  }
  if (getApiBaseUrl() !== prev) clearPerGatewayState();
  window.location.reload();
}

// ── opening the picker from anywhere (Login link, Settings) ────────────────

const OPEN_PICKER_EVENT = 'lintel:open-gateway-picker';

export function openGatewayPicker(): void {
  window.dispatchEvent(new Event(OPEN_PICKER_EVENT));
}

export function onOpenGatewayPicker(handler: () => void): () => void {
  window.addEventListener(OPEN_PICKER_EVENT, handler);
  return () => window.removeEventListener(OPEN_PICKER_EVENT, handler);
}
