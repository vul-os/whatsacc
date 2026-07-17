#!/usr/bin/env node
// Push every secret from ../.env.<env> into the matching Cloudflare Worker env.
// Skips comments, blanks, frontend-only (VITE_*), and the non-secret vars
// already pinned in wrangler.toml's [vars] blocks.
//
// Usage: node scripts/push-secrets.mjs dev
//        node scripts/push-secrets.mjs main

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const env = process.argv[2];
if (!env || !['dev', 'main'].includes(env)) {
  console.error('usage: node scripts/push-secrets.mjs <dev|main>');
  process.exit(1);
}

const envFile = resolve(here, `../../.env.${env}`);
const text = readFileSync(envFile, 'utf8');

const SKIP_KEYS = new Set(['APP_ENV', 'APP_PUBLIC_URL']);
const secrets = {};
for (const raw of text.split('\n')) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const eq = line.indexOf('=');
  if (eq < 0) continue;
  const key = line.slice(0, eq).trim();
  const value = line.slice(eq + 1).trim();
  if (!value || SKIP_KEYS.has(key) || key.startsWith('VITE_')) continue;
  secrets[key] = value;
}

const keys = Object.keys(secrets);
if (keys.length === 0) {
  console.error(`no secrets found in ${envFile}`);
  process.exit(1);
}

console.log(`Pushing ${keys.length} secrets to env=${env}:`);
for (const k of keys) console.log(`  • ${k}`);

const tmp = resolve(here, `../.secrets.${env}.tmp.json`);
writeFileSync(tmp, JSON.stringify(secrets));
try {
  const res = spawnSync('npx', ['wrangler', 'secret', 'bulk', tmp, '--env', env], {
    stdio: 'inherit',
    cwd: resolve(here, '..'),
  });
  process.exit(res.status ?? 1);
} finally {
  try { unlinkSync(tmp); } catch {}
}
