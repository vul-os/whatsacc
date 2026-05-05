export interface Env {
  DATABASE_URL: string;
  APP_ENV: string;
  JWT_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REDIRECT_URI: string;
  RESEND_API_KEY?: string;
  APP_PUBLIC_URL: string;
  WHATSAPP_APP_SECRET?: string;
  PORT: number;
}

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const required = (key: string): string => {
    const v = Deno.env.get(key);
    if (!v) throw new Error(`Missing required env var: ${key}`);
    return v;
  };
  cached = {
    DATABASE_URL: required('DATABASE_URL'),
    APP_ENV: Deno.env.get('APP_ENV') ?? 'local',
    JWT_SECRET: required('JWT_SECRET'),
    GOOGLE_CLIENT_ID: Deno.env.get('GOOGLE_CLIENT_ID') ?? '',
    GOOGLE_CLIENT_SECRET: Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '',
    GOOGLE_REDIRECT_URI: Deno.env.get('GOOGLE_REDIRECT_URI') ?? '',
    RESEND_API_KEY: Deno.env.get('RESEND_API_KEY'),
    APP_PUBLIC_URL: Deno.env.get('APP_PUBLIC_URL') ?? 'http://localhost:8000',
    WHATSAPP_APP_SECRET: Deno.env.get('WHATSAPP_APP_SECRET'),
    PORT: Number(Deno.env.get('PORT') ?? '8000'),
  };
  return cached;
}

export function resetEnvCache(): void {
  cached = null;
}
