import type { MiddlewareHandler } from 'hono';
import type { AuthClaims } from '../lib/db.ts';
import { getSql } from '../lib/db.ts';
import { verifyAccessToken } from '../lib/jwt.ts';
import { Forbidden, Unauthorized } from '../lib/errors.ts';

export type AuthVariables = {
  user: AuthClaims;
};

export type AppVariables = {
  user?: AuthClaims;
};

export type AppEnv = {
  Variables: AppVariables;
};

export function requireAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header('Authorization');
    if (!header || !header.startsWith('Bearer ')) {
      throw Unauthorized('missing_bearer');
    }
    const token = header.slice('Bearer '.length).trim();
    const claims = await verifyAccessToken(token);

    // Live user gate: a still-valid JWT must stop working the moment the
    // instance admin disables the user (or deletes them). This also refreshes
    // is_platform_admin from the DB so admin grants/revocations take effect
    // immediately instead of at token expiry — the claim in the JWT is never
    // trusted for /admin/* gating.
    const sql = getSql();
    const rows = await sql<{ status: string; is_platform_admin: boolean }[]>`
      select status, is_platform_admin from users where id = ${claims.sub}
    `;
    const u = rows[0];
    if (!u) throw Unauthorized('user_not_found');
    if (u.status === 'disabled') {
      throw Forbidden('user_disabled', 'This user has been disabled by the instance operator');
    }

    c.set('user', { ...claims, is_platform_admin: u.is_platform_admin });
    await next();
  };
}

export function getUser(c: { get(name: 'user'): AuthClaims | undefined }): AuthClaims {
  const u = c.get('user');
  if (!u) throw Unauthorized('not_authenticated');
  return u;
}
