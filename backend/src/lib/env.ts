// Cloudflare Workers env is a per-request binding (passed to fetch as the
// second arg). To preserve the legacy `getEnv()` call sites all over the
// codebase, we stash the active env in a module-level slot at the start of
// each request via setEnv(...). The Worker entry point's fetch handler is
// responsible for setting it before invoking app.fetch.

export interface Env {
  // Postgres / Neon connection string
  DATABASE_URL: string;
  // 'local' | 'dev' | 'main' | 'test'
  APP_ENV: string;
  // HS256 secret for our access/refresh tokens
  JWT_SECRET: string;
  // Google OAuth (sign-in)
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REDIRECT_URI: string;
  // Resend (transactional email)
  RESEND_API_KEY?: string;
  // Frontend base URL — used in email links + post-OAuth redirect
  APP_PUBLIC_URL: string;
  // Meta WhatsApp Cloud API
  WHATSAPP_APP_SECRET?: string;
  WHATSAPP_VERIFY_TOKEN?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_GRAPH_VERSION?: string;
  // Telegram Bot API
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  // Slack API
  SLACK_BOT_TOKEN?: string;
  SLACK_SIGNING_SECRET?: string;
  SLACK_APP_ID?: string;
  // Local-dev port (unused on Workers — we listen on platform-managed port)
  PORT?: number;
}

// Raw shape passed by Workers (everything is string at runtime).
type RawEnv = Record<string, string | undefined>;

let _activeEnv: Env | null = null;

function buildEnv(raw: RawEnv): Env {
  const required = (key: string): string => {
    const v = raw[key];
    if (!v) throw new Error(`Missing required env var: ${key}`);
    return v;
  };
  return {
    DATABASE_URL: required('DATABASE_URL'),
    APP_ENV: raw['APP_ENV'] ?? 'local',
    JWT_SECRET: required('JWT_SECRET'),
    GOOGLE_CLIENT_ID: raw['GOOGLE_CLIENT_ID'] ?? '',
    GOOGLE_CLIENT_SECRET: raw['GOOGLE_CLIENT_SECRET'] ?? '',
    GOOGLE_REDIRECT_URI: raw['GOOGLE_REDIRECT_URI'] ?? '',
    RESEND_API_KEY: raw['RESEND_API_KEY'],
    APP_PUBLIC_URL: raw['APP_PUBLIC_URL'] ?? 'http://localhost:8787',
    WHATSAPP_APP_SECRET: raw['WHATSAPP_APP_SECRET'],
    WHATSAPP_VERIFY_TOKEN: raw['WHATSAPP_VERIFY_TOKEN'],
    WHATSAPP_ACCESS_TOKEN: raw['WHATSAPP_ACCESS_TOKEN'],
    WHATSAPP_PHONE_NUMBER_ID: raw['WHATSAPP_PHONE_NUMBER_ID'],
    WHATSAPP_GRAPH_VERSION: raw['WHATSAPP_GRAPH_VERSION'] ?? 'v21.0',
    TELEGRAM_BOT_TOKEN: raw['TELEGRAM_BOT_TOKEN'],
    TELEGRAM_WEBHOOK_SECRET: raw['TELEGRAM_WEBHOOK_SECRET'],
    SLACK_BOT_TOKEN: raw['SLACK_BOT_TOKEN'],
    SLACK_SIGNING_SECRET: raw['SLACK_SIGNING_SECRET'],
    SLACK_APP_ID: raw['SLACK_APP_ID'],
    PORT: raw['PORT'] ? Number(raw['PORT']) : undefined,
  };
}

/**
 * Set the active env for this request. Called by the Worker entry point's
 * fetch handler with the per-request `env` binding. Safe to call repeatedly.
 */
export function setEnv(raw: RawEnv): void {
  _activeEnv = buildEnv(raw);
}

export function getEnv(): Env {
  if (!_activeEnv) {
    // In the Worker runtime the fetch/scheduled handlers always call
    // setEnv(env) first. Outside it (vitest, node scripts) there is no
    // per-request binding — lazily build from process.env, preserving the
    // legacy "mutate process.env then resetEnvCache()" pattern the tests use.
    if (typeof process !== 'undefined' && process.env) {
      _activeEnv = buildEnv(process.env as RawEnv);
      return _activeEnv;
    }
    throw new Error('Env not initialized — call setEnv(env) before getEnv()');
  }
  return _activeEnv;
}

export function resetEnvCache(): void {
  _activeEnv = null;
}
