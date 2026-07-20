// Cloudflare Workers can't open raw TCP, so postgres.js is replaced with
// @neondatabase/serverless (WebSocket Pool/Client). To avoid touching every
// caller, we expose a thin tagged-template wrapper that mirrors the parts of
// postgres.js's API actually used in this codebase: tagged literals,
// `sql.begin(fn)`, `tx.json(value)` for JSONB binding, and `sql.unsafe(raw)`.

import { Pool, type PoolClient } from '@neondatabase/serverless';
import type { Env } from './env.ts';

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

export class JsonMarker {
  constructor(public value: unknown) {}
}
export type JSONValue = unknown;

export interface SqlFn {
  <R = unknown[]>(strings: TemplateStringsArray, ...values: unknown[]): Promise<R>;
}

export interface TxSql extends SqlFn {
  json(value: unknown): JsonMarker;
  unsafe<R = unknown[]>(raw: string): Promise<R>;
  /**
   * Run `fn` inside a savepoint. On error the transaction is rolled back to
   * the savepoint (recovering the surrounding transaction from Postgres's
   * aborted state) and the error is rethrown. Used for best-effort work —
   * e.g. rate-limit counter updates — that must not poison the enclosing
   * transaction when it fails.
   */
  savepoint<T>(fn: (tx: TxSql) => Promise<T>): Promise<T>;
}

export interface Sql extends TxSql {
  begin<T>(fn: (tx: TxSql) => Promise<T>): Promise<T>;
}

interface QueryRunner {
  query: <R = unknown>(text: string, params: unknown[]) => Promise<{ rows: R[] }>;
}

function buildQuery(strings: TemplateStringsArray, values: unknown[]): { text: string; params: unknown[] } {
  let text = strings[0] ?? '';
  const params: unknown[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    params.push(v instanceof JsonMarker ? JSON.stringify(v.value) : v);
    text += `$${i + 1}${strings[i + 1] ?? ''}`;
  }
  return { text, params };
}

function makeTagged(runner: QueryRunner): TxSql {
  const fn = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const { text, params } = buildQuery(strings, values);
    const r = await runner.query(text, params);
    return r.rows;
  }) as TxSql;
  fn.json = (value: unknown) => new JsonMarker(value);
  fn.unsafe = (async (raw: string) => {
    const r = await runner.query(raw, []);
    return r.rows;
  }) as TxSql['unsafe'];
  let savepointSeq = 0;
  fn.savepoint = async <T>(cb: (tx: TxSql) => Promise<T>): Promise<T> => {
    const name = `wa_sp_${savepointSeq++}`;
    await runner.query(`SAVEPOINT ${name}`, []);
    try {
      const result = await cb(fn);
      await runner.query(`RELEASE SAVEPOINT ${name}`, []);
      return result;
    } catch (e) {
      await runner.query(`ROLLBACK TO SAVEPOINT ${name}`, []);
      throw e;
    }
  };
  return fn;
}

function createSql(connectionString: string): Sql {
  const pool = new Pool({ connectionString });
  const sql = makeTagged({
    query: async (text, params) => {
      const r = await pool.query(text, params);
      return { rows: r.rows };
    },
  }) as Sql;

  sql.begin = async <T>(fn: (tx: TxSql) => Promise<T>): Promise<T> => {
    const client: PoolClient = await pool.connect();
    try {
      await client.query('BEGIN');
      const tx = makeTagged({
        query: async (text, params) => {
          const r = await client.query(text, params);
          return { rows: r.rows };
        },
      });
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {/* ignore */}
      throw e;
    } finally {
      client.release();
    }
  };

  return sql;
}

// Workers forbids sharing I/O objects (sockets, WebSockets) across requests.
// We can't cache a Pool at module level — it'd open a WebSocket on request 1
// that's then unusable from request 2. Instead, the Worker entry point sets
// the connection string per-request and getSql() lazy-creates a fresh Sql
// (and underlying Pool) for THIS request. Any leftover Pool gets garbage
// collected with the request.
let _activeConnectionString: string | null = null;
let _activeSql: Sql | null = null;
let _testSql: Sql | null = null;

/**
 * Set the connection string for this request. Called by the Worker entry
 * point's fetch handler before any route runs.
 */
export function setDbConnectionString(connectionString: string): void {
  if (_activeConnectionString !== connectionString) {
    _activeConnectionString = connectionString;
    _activeSql = null;
  } else {
    // Same conn string but new request — invalidate the Pool either way to
    // avoid reusing sockets opened in the previous request's I/O context.
    _activeSql = null;
  }
}

export function setSqlForTests(sql: Sql | null): void {
  _testSql = sql;
}

export function getSql(): Sql {
  if (_testSql) return _testSql;
  if (!_activeConnectionString) {
    throw new Error('Database not initialized — call setDbConnectionString first');
  }
  if (!_activeSql) {
    _activeSql = createSql(_activeConnectionString);
  }
  return _activeSql;
}

export async function withRLS<T>(
  ctx: RlsContext | null,
  fn: (tx: TxSql) => Promise<T>,
): Promise<T> {
  const sql = getSql();
  return await sql.begin(async (tx) => {
    if (ctx) {
      await tx`select set_config('app.user_id', ${ctx.user_id}, true)`;
      await tx`select set_config('app.account_id', ${ctx.account_id ?? ''}, true)`;
      await tx`select set_config('app.is_platform_admin', ${ctx.is_platform_admin ? 'true' : 'false'}, true)`;
    } else {
      await tx`select set_config('app.user_id', '', true)`;
      await tx`select set_config('app.account_id', '', true)`;
      await tx`select set_config('app.is_platform_admin', 'false', true)`;
    }
    // Drop privilege from the connection role (which has BYPASSRLS on Neon)
    // to lintel_app (no BYPASSRLS) for the rest of the transaction. RLS
    // policies finally fire. SET LOCAL reverts on commit/rollback.
    // Settings made via set_config(..., true) persist across the role switch
    // because they're transaction-scoped, not role-scoped.
    await tx.unsafe('SET LOCAL ROLE lintel_app');
    return await fn(tx);
  });
}
