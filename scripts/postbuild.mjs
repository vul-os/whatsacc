#!/usr/bin/env node
// Post-build assembly for whatsacc.com.
//
// Vite builds the portal SPA into dist/ with index.html as its shell. But
// whatsacc.com's root must serve the hand-written marketing landing
// (web/landing.html), with docs, screenshots and fonts resolvable from the
// site root — while the SPA keeps handling /login, /signup, /app, ….
//
// Firebase Hosting serves exact static content (including automatic
// index.html resolution for "/") BEFORE consulting rewrites, so a
// "/" → "/landing.html" rewrite would never fire if the SPA shell stayed at
// dist/index.html. Instead we:
//
//   1. rename the Vite SPA shell  dist/index.html → dist/app.html
//      (firebase.json's catch-all rewrite "**" → "/app.html")
//   2. install web/landing.html as dist/index.html  (served at "/")
//   3. copy web/fonts/       → dist/fonts/
//      copy web/docs/        → dist/docs/   (md + manifest + index.html + vendor)
//      copy web/screenshots/ → dist/screenshots/
//
// The landing's relative links (docs/, screenshots/…) and the docs viewer's
// ../fonts/ references then resolve naturally from the site root.
//
// Runs automatically via npm's post-hooks after build / build:dev / build:main.

import { cp, rename, rm, stat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');
const web = join(root, 'web');

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function fail(msg) {
  console.error(`postbuild: ${msg}`);
  process.exit(1);
}

if (!(await exists(dist))) fail('dist/ not found — run `npm run build` first');
if (!(await exists(join(web, 'landing.html')))) fail('web/landing.html not found');

// 1. SPA shell → app.html. Idempotent: a fresh Vite build always recreates
//    dist/index.html as the SPA shell (it mounts #root); if this script
//    already ran, index.html is the landing page and app.html exists.
const indexPath = join(dist, 'index.html');
const appPath = join(dist, 'app.html');
const indexHtml = (await exists(indexPath)) ? await readFile(indexPath, 'utf8') : '';
const indexIsSpaShell = indexHtml.includes('id="root"');
if (indexIsSpaShell) {
  await rename(indexPath, appPath);
} else if (!(await exists(appPath))) {
  fail('dist/index.html is not the Vite SPA shell and dist/app.html is missing — rebuild first');
}

// 2. Landing becomes the root document.
await cp(join(web, 'landing.html'), indexPath);

// 3. Static site assets, copied fresh each time.
const copies = [
  ['fonts', 'fonts'],
  ['docs', 'docs'],
  ['screenshots', 'screenshots'],
];
for (const [from, to] of copies) {
  const src = join(web, from);
  if (!(await exists(src))) fail(`web/${from}/ not found`);
  const dest = join(dist, to);
  await rm(dest, { recursive: true, force: true });
  await cp(src, dest, { recursive: true });
}

console.log(
  'postbuild: dist/ assembled — index.html (landing), app.html (SPA shell), docs/, screenshots/, fonts/',
);
