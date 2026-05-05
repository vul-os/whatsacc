import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { getEnv } from './env.ts';
import { randomBytes, toBase64Url } from './random.ts';
import { BadRequest } from './errors.ts';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;
function jwks() {
  if (!jwksCache) jwksCache = createRemoteJWKSet(new URL(JWKS_URL));
  return jwksCache;
}

async function sha256(input: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(digest);
}

export type PkcePair = { codeVerifier: string; codeChallenge: string };

export async function makePkce(): Promise<PkcePair> {
  const codeVerifier = toBase64Url(randomBytes(32));
  const codeChallenge = toBase64Url(await sha256(codeVerifier));
  return { codeVerifier, codeChallenge };
}

export function buildAuthUrl(state: string, codeChallenge: string): string {
  const env = getEnv();
  if (!env.GOOGLE_CLIENT_ID) throw new Error('GOOGLE_CLIENT_ID not set');
  if (!env.GOOGLE_REDIRECT_URI) throw new Error('GOOGLE_REDIRECT_URI not set');
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'online',
    prompt: 'select_account',
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export type GoogleTokenResponse = {
  access_token: string;
  id_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
  refresh_token?: string;
};

export async function exchangeCode(
  code: string,
  codeVerifier: string,
): Promise<GoogleTokenResponse> {
  const env = getEnv();
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URI) {
    throw new Error('Google OAuth env not set');
  }
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    code,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: env.GOOGLE_REDIRECT_URI,
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw BadRequest('google_token_exchange_failed', text);
  }
  return (await res.json()) as GoogleTokenResponse;
}

export type GoogleIdClaims = JWTPayload & {
  email: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  sub: string;
};

export async function verifyIdToken(idToken: string): Promise<GoogleIdClaims> {
  const env = getEnv();
  if (!env.GOOGLE_CLIENT_ID) throw new Error('GOOGLE_CLIENT_ID not set');
  const { payload } = await jwtVerify(idToken, jwks(), {
    issuer: ISSUERS,
    audience: env.GOOGLE_CLIENT_ID,
  });
  if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
    throw BadRequest('google_id_token_invalid', 'missing sub/email');
  }
  return payload as GoogleIdClaims;
}
