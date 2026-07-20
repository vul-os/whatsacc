# lintel e2e-browser — real Chromium against a real gateway

Drives the actual portal in a real browser against a real `gateway` binary
(no mocks) to prove `src/lib/api.ts` — rewritten wholesale to target the Go
gateway instead of the retired Cloudflare Workers routes — actually works
when a human (or Chromium standing in for one) clicks through it. Before this
suite existed, `src/lib/api.ts` was verified only by a static route-parity
test and `curl`; nobody had loaded the portal in a browser against a booted
gateway.

```sh
npm run test:e2e            # headless, builds the gateway once, runs both spec files
npx playwright test --ui    # interactive runner, same build
npx playwright show-report  # after a run, view traces/screenshots/video on failure
```

## Why not `e2e/`

`../e2e` is a **Go** module — a cross-binary harness proving the gateway and
the controller interoperate over the real wire protocol (WebSocket + signed
command envelopes). This directory is unrelated: TypeScript, Playwright,
Chromium, and it never touches the controller or the device-pairing
protocol. Putting browser tests inside a Go module would mean either faking a
`go.mod` around npm tooling or awkwardly nesting an npm project inside one —
neither is how this repo organizes anything else. `e2e-browser/` is a plain
sibling top-level directory instead, matching how `backend/`, `gateway/`,
`controller/`, and `src/` are already separated by toolchain.

## What "real gateway" means here

`global-setup.ts` runs once before any test:

1. `vite build` — the same bundler invocation `npm run build` uses.
2. Copies that build into `gateway/internal/portal/dist/` — the exact seam
   `gateway/Makefile`'s `portal` target populates.
3. `go build -a -tags portal ./cmd/gateway` — the exact `build-portal` target,
   producing a single self-contained binary with the real React SPA embedded.

Every test then boots *that* binary (`fixtures/gateway.ts`'s `startGateway`)
on a scratch SQLite data dir and a free port, and Chromium is pointed at its
real origin. This is deliberately **not** `vite dev` pointed at a separately
running gateway: the embedded binary is what actually ships (it's also what
the Tauri desktop shell embeds), and the specific bug class this suite exists
to catch — the embedded portal's SPA-fallback answering an unmatched path
with `200 + index.html` instead of a 404 — only reproduces when the frontend
and the API are genuinely the same origin, which only the embedded build can
give you.

One gateway process per spec **file** (not per test — rebuilding/rebooting
per test would be slow for no isolation benefit, since each test uses a
unique email and a scratch data dir is already file-scoped). Each spec file's
`beforeAll`/`afterAll` boots and tears it down.

## What each file does

- **`fixtures/gateway.ts`** — spawns/health-checks/tears down a gateway
  process on an isolated data dir + free port.
- **`fixtures/test.ts`** — extends Playwright's `test` with an auto-fixture
  that fails a test if the page logs a `console.error`, throws an uncaught
  exception or unhandled promise rejection, crashes, or receives a 2xx
  response under `/v1/*` that isn't JSON (the SPA-fallback trap, checked at
  the network level independent of whether the app happens to swallow it).
- **`money-path.spec.ts`** — sign up (which bundles creating the first
  location), sign out, sign back in, add an access point, attempt an open
  with no controller paired (asserts the honest `delivery: "no_device"`
  outcome, not a crash or a fabricated ack), claim platform-admin and read
  the result back out of the audit log, asserting the timestamp is a real
  today's-date and never `1970` / `Invalid Date` / `NaN`.
- **`auth-flows.spec.ts`** — logout (asserts the session dies both client-
  and server-side, and a protected route bounces to `/login` afterward), and
  a stale-access-token 401 that triggers `apiFetch`'s one-shot
  refresh-and-retry, reproducing the exact historical bug (flat vs.
  `{tokens:{...}}`-nested refresh response) without waiting out the real
  15-minute access-token TTL.

## What isn't covered here

- Anything requiring a paired **controller** (real device acks, lockdown,
  offline-grant redemption) — that's `../e2e`'s job; this suite only proves
  the *honest degraded* state (`no_device`) from the portal's point of view.
- The `CreateLocationModal`'s standalone "+ New location" flow
  (`src/components/locations/CreateLocationModal.tsx`) — it hard-requires a
  Mapbox address selection with no manual-entry fallback, and does nothing
  at all without `VITE_MAPBOX_TOKEN` (shows an honest "add the token"
  message and blocks). The money-path's "create a location" step instead
  uses `Signup.tsx`'s own location step, which needs no address and is how
  every account's first location is actually created. Exercising the
  Mapbox-gated modal would mean either baking in a token and mocking Mapbox's
  geocoding API (a third-party dependency, not the gateway — defensible, but
  out of scope for this pass) or accepting a real network call to Mapbox in
  CI.
- Chat channels (WhatsApp/Slack/Telegram) — no portal surface exercises them
  directly; they're a separate webhook surface.
