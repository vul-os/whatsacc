// Route-parity test — the safeguard against the exact bug that motivated
// this test's existence: src/lib/api.ts (the frontend client) drifting from
// the routes gateway/internal/httpapi/server.go actually serves.
//
// The gateway is the product that ships (embedded into the gateway binary
// as the portal, reused by the Tauri desktop shell). backend/src/app.ts is a
// historical Cloudflare Workers reference kept for behavioral-spec purposes
// only — this test does NOT check against it.
//
// How it works:
//  1. Parse api.ts's own source with the TypeScript compiler API (not
//     regex) to find every `apiFetch(path, init)` call, extracting the
//     method (from `init.method`, default GET) and the path — including
//     resolving template-literal path params (`${id}`) to a placeholder.
//  2. Shell out to `go run ./cmd/routegen` inside gateway/, which parses
//     server.go's Router() with go/ast and prints every registered
//     "METHOD /v1/..." pattern as JSON. That's the single source of truth
//     for what the gateway serves — see gateway/cmd/routegen/main.go.
//  3. Diff: every frontend call must have a matching gateway route, UNLESS
//     it's in KNOWN_UNAVAILABLE below (an endpoint the gateway genuinely
//     doesn't implement yet, where the frontend is expected to degrade
//     gracefully — see api.ts's per-function doc comments for why each one
//     is there). Anything else unmatched is a real drift bug and fails loudly.
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_VERSION_PREFIX } from '../api';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const apiTsPath = path.join(repoRoot, 'src/lib/api.ts');
const gatewayDir = path.join(repoRoot, 'gateway');

type FrontendCall = {
  method: string;
  rawPath: string;
  normalizedPath: string;
  line: number;
};

type GatewayRoute = { method: string; path: string };

// ── frontend extraction (TypeScript AST, not regex) ────────────────────────

/**
 * Normalize a path-argument AST node to a pathname with `{param}` in place
 * of every dynamic segment, and query-string-producing expressions dropped
 * entirely.
 *
 * Heuristic for template literals: a substitution immediately after a `/`
 * (i.e. the accumulated literal text so far ends with '/') is a path
 * parameter ("/access-points/${id}" -> "/access-points/{param}"). A
 * substitution that does NOT follow a trailing slash is a query-string
 * suffix ("/grants${qs}", "/admin/accounts${adminListQs(q)}") and
 * contributes nothing to the pathname — which matches how the gateway's
 * mux patterns work (query strings are never part of the registered
 * pattern).
 */
function normalizeTemplate(node: ts.TemplateExpression): string {
  let out = node.head.text;
  for (const span of node.templateSpans) {
    if (out.endsWith('/')) {
      out += '{param}';
    }
    out += span.literal.text;
  }
  return out;
}

function pathArgToString(node: ts.Expression): string | null {
  if (ts.isStringLiteralLike(node)) return node.text; // StringLiteral | NoSubstitutionTemplateLiteral
  if (ts.isTemplateExpression(node)) return normalizeTemplate(node);
  return null;
}

function methodOf(args: readonly ts.Expression[]): string {
  if (args.length < 2) return 'GET';
  const init = args[1];
  if (!ts.isObjectLiteralExpression(init)) return 'GET';
  for (const prop of init.properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      ts.isIdentifier(prop.name) &&
      prop.name.text === 'method' &&
      ts.isStringLiteralLike(prop.initializer)
    ) {
      return prop.initializer.text;
    }
  }
  return 'GET';
}

function normalizePath(p: string): string {
  const noQuery = p.split('?')[0];
  const trimmed = noQuery.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

function extractFrontendCalls(source: string): FrontendCall[] {
  const sf = ts.createSourceFile('api.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const calls: FrontendCall[] = [];

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'apiFetch' &&
      node.arguments.length > 0
    ) {
      const rawPath = pathArgToString(node.arguments[0]);
      if (rawPath !== null) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
        calls.push({
          method: methodOf(node.arguments),
          rawPath,
          normalizedPath: normalizePath(rawPath),
          line: line + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return calls;
}

// ── gateway extraction (shells out to the Go source of truth) ──────────────

function loadGatewayRoutes(): GatewayRoute[] {
  const out = execFileSync('go', ['run', './cmd/routegen'], {
    cwd: gatewayDir,
    encoding: 'utf-8',
  });
  const routes = JSON.parse(out) as GatewayRoute[];
  return routes.map((r) => ({ method: r.method, path: normalizePath(r.path) }));
}

function normalizeGoPath(p: string): string {
  // Go 1.22 mux params are "{id}", "{token}", etc. — collapse to the same
  // placeholder the frontend normalizer emits.
  return p.replace(/\{[^/]+\}/g, '{param}');
}

// ── known, intentional gaps (gateway hasn't implemented these yet) ─────────
//
// Every entry here must correspond to a doc comment in api.ts explaining why
// the call exists anyway and how the UI degrades. This list is the ONLY
// thing standing between "frontend calls a route the gateway doesn't have"
// failing the build — keep it short, and delete entries the moment the
// gateway implements the route for real.
const KNOWN_UNAVAILABLE: Array<{ method: string; path: string }> = [
  { method: 'GET', path: '/reference/countries' },
  { method: 'GET', path: '/phones/me/phones' },
  { method: 'POST', path: '/phones/me/phones' },
  { method: 'PUT', path: '/auth/me/slack' },
  { method: 'PATCH', path: '/auth/me/profile' },
  { method: 'POST', path: '/auth/forgot-password' },
  { method: 'POST', path: '/auth/reset-password' },
  { method: 'POST', path: '/auth/verify-email' },
  { method: 'POST', path: '/auth/update-password' },
  { method: 'GET', path: '/access-points/{param}/maintenance' },
  { method: 'POST', path: '/access-points/{param}/maintenance' },
  { method: 'GET', path: '/analytics/accounts/{param}/summary' },
  { method: 'GET', path: '/analytics/accounts/{param}/insights' },
  { method: 'GET', path: '/analytics/locations/{param}/summary' },
];

describe('frontend/gateway route parity', () => {
  it('every apiFetch() call in src/lib/api.ts targets a route the gateway serves (or is an acknowledged gap)', () => {
    const source = readFileSync(apiTsPath, 'utf-8');
    const frontendCalls = extractFrontendCalls(source);
    expect(frontendCalls.length).toBeGreaterThan(20); // sanity: extraction actually ran

    const gatewayRoutes = loadGatewayRoutes();
    expect(gatewayRoutes.length).toBeGreaterThan(20); // sanity: routegen actually ran

    const gatewaySet = new Set(gatewayRoutes.map((r) => `${r.method} ${normalizeGoPath(r.path)}`));
    const unavailableSet = new Set(KNOWN_UNAVAILABLE.map((r) => `${r.method} ${r.path}`));

    const broken: string[] = [];
    const acknowledgedGaps: string[] = [];

    for (const call of frontendCalls) {
      // Every apiFetch call is sent with API_VERSION_PREFIX prepended (see
      // apiFetch in api.ts) — reproduce that here so the comparison is
      // against what actually goes over the wire.
      const wirePath = normalizePath(`${API_VERSION_PREFIX}${call.normalizedPath}`);
      const key = `${call.method} ${wirePath}`;
      // Path relative to API_VERSION_PREFIX, for the KNOWN_UNAVAILABLE table.
      const bareKey = `${call.method} ${call.normalizedPath}`;

      if (gatewaySet.has(key)) continue;
      if (unavailableSet.has(bareKey)) {
        acknowledgedGaps.push(`${bareKey}  (api.ts:${call.line} — "${call.rawPath}")`);
        continue;
      }
      broken.push(
        `${key}  (api.ts:${call.line} — apiFetch("${call.rawPath}") has no matching gateway route)`,
      );
    }

    if (broken.length > 0) {
      const gatewayList = gatewayRoutes.map((r) => `  ${r.method} ${r.path}`).join('\n');
      throw new Error(
        `${broken.length} frontend API call(s) target routes the gateway does not serve:\n\n` +
          broken.map((b) => `  ✗ ${b}`).join('\n') +
          `\n\nIf the gateway genuinely doesn't implement this yet (and the frontend degrades ` +
          `gracefully), add it to KNOWN_UNAVAILABLE in this test with a matching doc comment in ` +
          `api.ts. Otherwise this is route drift — fix the path in src/lib/api.ts.\n\n` +
          `Routes the gateway actually serves (gateway/internal/httpapi/server.go):\n${gatewayList}\n`,
      );
    }

    // Not a failure, but surfaced so `vitest run --reporter=verbose` (and
    // anyone reading test output) can see the acknowledged-gap inventory
    // without having to go spelunking through api.ts comments.
    if (acknowledgedGaps.length > 0) {
      console.log(
        `\n[routeParity] ${acknowledgedGaps.length} frontend call(s) hit gateway routes that ` +
          `don't exist yet, intentionally (see KNOWN_UNAVAILABLE):\n` +
          acknowledgedGaps.map((g) => `  · ${g}`).join('\n') +
          '\n',
      );
    }
  });

  it('KNOWN_UNAVAILABLE has no stale entries (route now exists, or frontend call was removed)', () => {
    const source = readFileSync(apiTsPath, 'utf-8');
    const frontendCalls = extractFrontendCalls(source);
    const frontendKeys = new Set(frontendCalls.map((c) => `${c.method} ${c.normalizedPath}`));

    const gatewayRoutes = loadGatewayRoutes();
    const gatewaySet = new Set(gatewayRoutes.map((r) => `${r.method} ${normalizeGoPath(r.path)}`));

    const stale: string[] = [];
    for (const entry of KNOWN_UNAVAILABLE) {
      const key = `${entry.method} ${entry.path}`;
      const wireKey = `${entry.method} ${normalizePath(`${API_VERSION_PREFIX}${entry.path}`)}`;
      if (!frontendKeys.has(key)) {
        stale.push(`${key} — no apiFetch() call in api.ts uses this path anymore; remove the entry`);
      } else if (gatewaySet.has(wireKey)) {
        stale.push(`${key} — the gateway now serves this route; remove the entry and wire it up`);
      }
    }

    if (stale.length > 0) {
      throw new Error(
        `KNOWN_UNAVAILABLE in routeParity.test.ts has ${stale.length} stale entr${stale.length === 1 ? 'y' : 'ies'}:\n` +
          stale.map((s) => `  ✗ ${s}`).join('\n'),
      );
    }
  });
});
