// Test database lifecycle. Uses the same DATABASE_URL as dev — there is one
// local Postgres database. Tests TRUNCATE all data tables between cases, so
// only point this at a database you don't mind losing data on.

import postgres from 'postgres';
import { resetEnvCache } from '@/lib/env.ts';

const MIGRATION_NAME_RE = /^(\d{14}[a-z]?)_(.+)\.sql$/;

let migrated = false;
let testSql: ReturnType<typeof postgres> | null = null;

export type TestDb = {
  sql: ReturnType<typeof postgres>;
  url: string;
};

export function resolveTestDatabaseUrl(): string | null {
  const url = (Deno.env.get('DATABASE_URL') ?? '').trim();
  return url || null;
}

export async function setupTestDb(): Promise<TestDb> {
  const url = resolveTestDatabaseUrl();
  if (!url) {
    throw new Error(
      'DATABASE_URL not set. Add it to ../.env (or pass --env-file=../.env to deno test).',
    );
  }

  resetEnvCache();

  if (!testSql) {
    testSql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
  }

  if (!migrated) {
    await applyAllMigrations(testSql);
    migrated = true;
  }
  return { sql: testSql, url };
}

/**
 * Truncate all tables that hold per-test data. Reference tables (countries,
 * currencies, fx_rates, plans) are repopulated below.
 */
export async function resetData(): Promise<void> {
  const { sql } = await setupTestDb();
  // Discover non-reference user-data tables. Skip reference data + the
  // migration tracker so we don't have to re-migrate between tests.
  const PRESERVE = new Set([
    'schema_migrations',
    'currencies',
    'countries',
    'fx_rates',
    'plans',
  ]);
  const rows = await sql<{ tablename: string }[]>`
    select tablename from pg_tables where schemaname = 'public'
  `;
  const targets = rows.map((r) => r.tablename).filter((t) => !PRESERVE.has(t));
  if (targets.length === 0) return;
  const escaped = targets.map((t) => `public."${t.replace(/"/g, '""')}"`).join(', ');
  await sql.unsafe(`TRUNCATE ${escaped} RESTART IDENTITY CASCADE`);
}

export async function teardownTestDb(): Promise<void> {
  if (testSql) {
    await testSql.end({ timeout: 5 });
    testSql = null;
    migrated = false;
  }
}

async function applyAllMigrations(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version    text        PRIMARY KEY,
      name       text        NOT NULL,
      checksum   text        NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const dir = await resolveMigrationsDir();
  const files = await loadMigrationFiles(dir);
  for (const m of files) {
    const exists = await sql<{ exists: boolean }[]>`
      select exists(select 1 from schema_migrations where version = ${m.version}) as exists
    `;
    if (exists[0]?.exists) continue;
    await sql.begin(async (tx) => {
      await tx.unsafe(m.body);
      await tx`
        insert into schema_migrations (version, name, checksum)
        values (${m.version}, ${m.name}, ${m.checksum})
        on conflict (version) do nothing
      `;
    });
  }
}

async function resolveMigrationsDir(): Promise<string> {
  for (const c of ['migrations', 'backend/migrations']) {
    try {
      const st = await Deno.stat(c);
      if (st.isDirectory) return c;
    } catch {
      // ignore
    }
  }
  throw new Error('migrations dir not found (looked in ./migrations and ./backend/migrations)');
}

type Migration = { version: string; name: string; body: string; checksum: string };

async function loadMigrationFiles(dir: string): Promise<Migration[]> {
  const out: Migration[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile) continue;
    const m = MIGRATION_NAME_RE.exec(entry.name);
    if (!m) continue;
    const body = await Deno.readTextFile(`${dir}/${entry.name}`);
    out.push({
      version: m[1]!,
      name: m[2]!,
      body,
      checksum: await sha256Hex(body),
    });
  }
  out.sort((a, b) => (a.version < b.version ? -1 : 1));
  return out;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
