// whatsacc database CLI.
//
// Usage (run from the backend/ directory):
//
//   deno task migrate                    Apply pending migrations (local)
//   deno task migrate:dev                Apply pending migrations (dev)
//   deno task migrate:main               Apply pending migrations (main)
//
// Or invoke directly:
//
//   deno run -A --env-file=../.env cmd/migrate/main.ts up
//   deno run -A --env-file=../.env cmd/migrate/main.ts reset
//   deno run -A --env-file=../.env cmd/migrate/main.ts seed
//   deno run -A --env-file=../.env cmd/migrate/main.ts reset seed
//
// Env profiles are selected via Deno's --env-file flag at the task level;
// inside this script we just read DATABASE_URL.
//
// Required env:
//   DATABASE_URL   PostgreSQL connection string

import postgres from 'postgres';
import { parseArgs } from 'jsr:@std/cli@^1.0.0/parse-args';

const MIGRATION_NAME_RE = /^(\d{14}[a-z]?)_(.+)\.sql$/;

interface MigrationFile {
  version: string;
  name: string;
  path: string;
  checksum: string;
  body: string;
}

const flags = parseArgs(Deno.args, {
  string: ['dir'],
  default: { dir: 'migrations' },
});

const subcommands = (flags._.length ? flags._ : ['up']).map((s) => String(s).toLowerCase());

const databaseUrl = (Deno.env.get('DATABASE_URL') ?? '').trim();
if (!databaseUrl) {
  fatal('DATABASE_URL is required (set in ../.env, ../.env.dev, ../.env.main, or environment)');
}

const dir = await resolveDir(String(flags.dir), 'backend/migrations');

const sql = postgres(databaseUrl, { prepare: false, max: 1, onnotice: () => {} });

try {
  for (const cmd of subcommands) {
    switch (cmd) {
      case 'up':
        await cmdUp();
        break;
      case 'reset':
        await cmdReset();
        break;
      case 'seed':
        await cmdSeed();
        break;
      default:
        fatal(`unknown subcommand "${cmd}"\n\nValid: up, reset, seed`);
    }
  }
  console.log('\n── Done ──────────────────────────────────────────────────────────────');
} finally {
  await sql.end({ timeout: 5 });
}

async function cmdUp() {
  console.log('\n── Migrations ────────────────────────────────────────────────────────');
  await ensureMigrationTable();
  const migrations = await loadMigrations(dir);
  if (migrations.length === 0) {
    console.log('  No migration files found.');
    return;
  }

  let applied = 0;
  for (const m of migrations) {
    if (await isApplied(m.version)) {
      console.log(`  skip  ${baseName(m.path)}`);
      continue;
    }
    console.log(`  apply ${baseName(m.path)}`);
    await applyMigration(m);
    applied++;
  }
  console.log(`  Applied ${applied} migration(s).`);
}

async function cmdReset() {
  console.log('\n── Reset ─────────────────────────────────────────────────────────────');
  console.log('  Dropping public schema (CASCADE)...');
  await sql.unsafe(`
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
    GRANT ALL ON SCHEMA public TO CURRENT_USER;
    GRANT ALL ON SCHEMA public TO public;
  `);
  console.log('  Schema dropped and recreated.');

  await ensureMigrationTable();
  const migrations = await loadMigrations(dir);
  for (const m of migrations) {
    console.log(`  apply ${baseName(m.path)}`);
    await applyMigration(m);
  }
  console.log(`  Reset complete — applied ${migrations.length} migration(s).`);
}

async function cmdSeed() {
  console.log('\n── Seed SQL ───────────────────────────────────────────────────────────');
  const seedPath = await findSeedSqlPath();
  if (!seedPath) {
    fatal('seed.sql not found (expected ./seed.sql or ./backend/seed.sql)');
  }
  console.log(`  apply ${seedPath}`);
  const body = await Deno.readTextFile(seedPath);
  await sql.unsafe(body);
}

async function ensureMigrationTable() {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version    text        PRIMARY KEY,
      name       text        NOT NULL,
      checksum   text        NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT timezone('utc', now())
    );
  `);
}

async function isApplied(version: string): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM public.schema_migrations WHERE version = ${version}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

async function applyMigration(m: MigrationFile) {
  await sql.begin(async (tx) => {
    await tx.unsafe(m.body);
    await tx`
      INSERT INTO public.schema_migrations (version, name, checksum)
      VALUES (${m.version}, ${m.name}, ${m.checksum})
      ON CONFLICT (version) DO NOTHING
    `;
  });
}

async function loadMigrations(directory: string): Promise<MigrationFile[]> {
  const out: MigrationFile[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if (!entry.isFile) continue;
    const match = MIGRATION_NAME_RE.exec(entry.name);
    if (!match) continue;
    const fullPath = `${directory}/${entry.name}`;
    const body = await Deno.readTextFile(fullPath);
    out.push({
      version: match[1]!,
      name: match[2]!,
      path: fullPath,
      checksum: await sha256Hex(body),
      body,
    });
  }
  out.sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
  return out;
}

async function resolveDir(primary: string, fallback: string): Promise<string> {
  if (await isDir(primary)) return primary;
  if (await isDir(fallback)) return fallback;
  return primary;
}

async function isDir(p: string): Promise<boolean> {
  try {
    const st = await Deno.stat(p);
    return st.isDirectory;
  } catch {
    return false;
  }
}

async function findSeedSqlPath(): Promise<string | null> {
  for (const candidate of ['seed.sql', 'backend/seed.sql']) {
    try {
      const st = await Deno.stat(candidate);
      if (st.isFile) return candidate;
    } catch {
      // ignore
    }
  }
  return null;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function baseName(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function fatal(msg: string): never {
  console.error(`error: ${msg}`);
  Deno.exit(1);
}
