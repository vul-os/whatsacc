import postgres from 'postgres';
import { getEnv, type Env } from './env.ts';

export type { Env };

export type AuthClaims = {
  sub: string;
  email: string;
  account_id?: string | null;
  is_platform_admin: boolean;
};

export type RlsContext = {
  user_id: string;
  account_id?: string | null;
  is_platform_admin: boolean;
};

let sqlClient: ReturnType<typeof postgres> | null = null;

export function getSql(): postgres.Sql {
  if (!sqlClient) {
    const env = getEnv();
    sqlClient = postgres(env.DATABASE_URL, { prepare: false, max: 1 });
  }
  return sqlClient;
}

export type Sql = postgres.Sql;
export type TxSql = postgres.TransactionSql;

export async function withRLS<T>(
  ctx: RlsContext | null,
  fn: (tx: TxSql) => Promise<T>,
): Promise<T> {
  const sql = getSql();
  const result = await sql.begin(async (tx) => {
    if (ctx) {
      await tx`select set_config('app.user_id', ${ctx.user_id}, true)`;
      await tx`select set_config('app.account_id', ${ctx.account_id ?? ''}, true)`;
      await tx`select set_config('app.is_platform_admin', ${ctx.is_platform_admin ? 'true' : 'false'}, true)`;
    } else {
      await tx`select set_config('app.user_id', '', true)`;
      await tx`select set_config('app.account_id', '', true)`;
      await tx`select set_config('app.is_platform_admin', 'false', true)`;
    }
    return (await fn(tx)) as unknown as T & { length?: never };
  });
  return result as unknown as T;
}
