// Whatsacc database migration runner (Node version, post-Deno port).
//
// Usage (run from the backend/ directory):
//   npm run migrate                 Apply pending migrations against ../.env
//   npm run migrate:dev             ... against ../.env.dev
//   npm run migrate:main            ... against ../.env.main
//
// Or invoke directly with Node 20+:
//   node --env-file=../.env scripts/migrate.mjs            (same as `up`)
//   node --env-file=../.env scripts/migrate.mjs up
//   node --env-file=../.env scripts/migrate.mjs reset
//   node --env-file=../.env scripts/migrate.mjs seed
//   node --env-file=../.env scripts/migrate.mjs reset seed
//
// Required env:
//   DATABASE_URL   PostgreSQL connection string (libpq style; pg.js handles it)

import { readdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookup } from 'node:dns/promises';
import pg from 'pg';

const MIGRATION_NAME_RE = /^(\d{14}[a-z]?)_(.+)\.sql$/;

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoBackend = dirname(__dirname);

// CLI args: subcommands (up/reset/seed) plus optional --dir=<path>
const rawArgs = process.argv.slice(2);
const flags = { dir: 'migrations' };
const cmds = [];
for (const a of rawArgs) {
  if (a.startsWith('--dir=')) flags.dir = a.slice('--dir='.length);
  else cmds.push(a.toLowerCase());
}
if (cmds.length === 0) cmds.push('up');

const databaseUrl = (process.env.DATABASE_URL ?? '').trim();
if (!databaseUrl) {
  fatal('DATABASE_URL is required (set in ../.env, ../.env.dev, ../.env.main)');
}

const dir = await resolveDir(flags.dir, join(repoBackend, 'migrations'));

// Node's default multi-IP connect tries all DNS results in parallel — broken
// IPv6 + Neon's load-balanced IPv4 set was tripping that path on this user's
// network. Force a single-IPv4 lookup and hand pg the resolved address so
// it connects to exactly one host (same way libpq via psql works fine).
const url = new URL(databaseUrl);
const { address } = await lookup(url.hostname, { family: 4 });
const client = new pg.Client({
  host: address,
  port: Number(url.port) || 5432,
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: url.pathname.replace(/^\//, ''),
  ssl: { servername: url.hostname, rejectUnauthorized: false },
});
await client.connect();

try {
  for (const cmd of cmds) {
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
  await client.end().catch(() => {});
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
      console.log(`  skip  ${m.fileName}`);
      continue;
    }
    console.log(`  apply ${m.fileName}`);
    await applyMigration(m);
    applied++;
  }
  console.log(`  Applied ${applied} migration(s).`);
}

async function cmdReset() {
  console.log('\n── Reset ─────────────────────────────────────────────────────────────');
  console.log('  Dropping public schema (CASCADE)...');
  await client.query(`
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
    GRANT ALL ON SCHEMA public TO CURRENT_USER;
    GRANT ALL ON SCHEMA public TO public;
  `);
  console.log('  Schema dropped and recreated.');

  await ensureMigrationTable();
  const migrations = await loadMigrations(dir);
  for (const m of migrations) {
    console.log(`  apply ${m.fileName}`);
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
  const body = await readFile(seedPath, 'utf8');
  await client.query(body);
}

async function ensureMigrationTable() {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version    text        PRIMARY KEY,
      name       text        NOT NULL,
      checksum   text        NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

async function isApplied(version) {
  const r = await client.query(
    'SELECT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = $1) AS "exists"',
    [version],
  );
  return Boolean(r.rows[0]?.exists);
}

async function applyMigration(m) {
  await client.query('BEGIN');
  try {
    await client.query(m.body);
    await client.query(
      `INSERT INTO public.schema_migrations (version, name, checksum)
       VALUES ($1, $2, $3) ON CONFLICT (version) DO NOTHING`,
      [m.version, m.name, m.checksum],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

async function loadMigrations(directory) {
  const out = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = MIGRATION_NAME_RE.exec(entry.name);
    if (!match) continue;
    const fullPath = join(directory, entry.name);
    const body = await readFile(fullPath, 'utf8');
    out.push({
      version: match[1],
      name: match[2],
      fileName: entry.name,
      checksum: createHash('sha256').update(body).digest('hex'),
      body,
    });
  }
  out.sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
  return out;
}

async function resolveDir(primary, fallback) {
  if (await isDir(primary)) return primary;
  if (await isDir(fallback)) return fallback;
  return primary;
}

async function isDir(p) {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function findSeedSqlPath() {
  for (const candidate of [join(repoBackend, 'seed.sql'), 'seed.sql']) {
    try {
      const s = await stat(candidate);
      if (s.isFile()) return candidate;
    } catch {/* ignore */}
  }
  return null;
}

function fatal(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}
