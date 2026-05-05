import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { getEnv } from './env.ts';
import type { AuthClaims } from './db.ts';
import { Unauthorized } from './errors.ts';

const ISSUER = 'whatsacc';

function secretKey(): Uint8Array {
  const env = getEnv();
  if (!env.JWT_SECRET) throw new Error('JWT_SECRET not set');
  return new TextEncoder().encode(env.JWT_SECRET);
}

export type AccessTokenPayload = {
  sub: string;
  email: string;
  account_id?: string | null;
  is_platform_admin: boolean;
};

export async function signAccessToken(
  payload: AccessTokenPayload,
  ttlSeconds = 900,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: JWTPayload = {
    email: payload.email,
    account_id: payload.account_id ?? null,
    is_platform_admin: payload.is_platform_admin,
  };
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(payload.sub)
    .setIssuer(ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(secretKey());
}

export async function verifyAccessToken(token: string): Promise<AuthClaims> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { issuer: ISSUER });
    if (!payload.sub || typeof payload.sub !== 'string') {
      throw Unauthorized('invalid_token', 'missing sub');
    }
    if (typeof payload.email !== 'string') {
      throw Unauthorized('invalid_token', 'missing email');
    }
    return {
      sub: payload.sub,
      email: payload.email,
      account_id: (payload.account_id as string | null | undefined) ?? null,
      is_platform_admin: Boolean(payload.is_platform_admin),
    };
  } catch (err) {
    if (err instanceof Error && 'status' in err) throw err;
    throw Unauthorized('invalid_token', (err as Error).message);
  }
}

export async function signShortToken(
  claims: Record<string, unknown>,
  ttlSeconds = 600,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(secretKey());
}

export async function verifyShortToken(token: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, secretKey(), { issuer: ISSUER });
  return payload;
}
