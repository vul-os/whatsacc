import type { Context } from 'hono';
import type { AuthClaims, RlsContext, TxSql } from '../lib/db.ts';
import { withRLS } from '../lib/db.ts';
import type { AppEnv } from './auth.ts';

export function rlsCtxFromClaims(claims: AuthClaims): RlsContext {
  return {
    user_id: claims.sub,
    account_id: claims.account_id ?? null,
    is_platform_admin: claims.is_platform_admin,
  };
}

export async function withUserDb<T>(
  c: Context<AppEnv>,
  fn: (tx: TxSql) => Promise<T>,
): Promise<T> {
  const claims = c.get('user');
  if (!claims) throw new Error('withUserDb requires requireAuth()');
  return await withRLS(rlsCtxFromClaims(claims), fn);
}

export async function withAnonDb<T>(fn: (tx: TxSql) => Promise<T>): Promise<T> {
  return await withRLS(null, fn);
}
