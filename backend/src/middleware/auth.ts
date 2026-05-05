import type { MiddlewareHandler } from 'hono';
import type { AuthClaims } from '../lib/db.ts';
import { verifyAccessToken } from '../lib/jwt.ts';
import { Unauthorized } from '../lib/errors.ts';

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
    c.set('user', claims);
    await next();
  };
}

export function getUser(c: { get(name: 'user'): AuthClaims | undefined }): AuthClaims {
  const u = c.get('user');
  if (!u) throw Unauthorized('not_authenticated');
  return u;
}
