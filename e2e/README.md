# whatsacc e2e — cross-module integration harness

Proves the **gateway** (`../gateway`) and the **controller** (`../controller`)
interoperate over the *real* wire protocol (`../proto`), by booting the actual
shipped binaries and driving them over real HTTP + RFC 6455 WebSocket + the LAN
grant HTTP surface.

```
go test ./...            # from this dir; builds both binaries, runs the suite (~15–20s + build)
go test -run TestMoneyPath -v ./...
```

Requires the Go toolchain and the sibling `../gateway` and `../controller`
modules on disk (their deps are fetched on first build). Nothing else — no
Postgres, no Docker, no network at runtime.

## Why subprocess, not in-process

The task asked for an in-process harness that imports both modules (optionally
via `go.work` / `replace`). **That is impossible here, and no `go.work` or
`replace` can fix it:** every package in both modules lives under `internal/`
(`gateway/internal/...`, `controller/internal/...`). Go's internal-package rule
keys on *import paths*, not modules or workspaces — an importer is allowed only
if its path is under the parent of `internal/`. This module's path is
`github.com/vul-os/whatsacc/e2e`, a **sibling** of
`github.com/vul-os/whatsacc/gateway`, so it can never import
`.../gateway/internal/*` (or the controller's). `go.work`/`replace` only change
module *resolution*; they do not relax `internal/`. The only in-process routes
would be relocating this module under one of the others, or adding public
re-export shims to those modules — both out of scope ("do not modify
gateway/controller source").

So the harness drives the two **binaries** as subprocesses. This is a *stronger*
interop proof than importing would be: it exercises the shipped artifacts, the
real TCP/WebSocket/LAN transports, and the two **independent** JCS + Ed25519
implementations against each other (the whole point of the contract).

Consequently:

- **No `go.work`, no `replace`.** `e2e/go.mod` depends on *nothing* from the
  other modules as Go imports — only the standard library. Each module's
  `go test ./...` stays exactly as it was; adding this module is invisible to
  the gateway/controller CI jobs (they run with `working-directory` set and
  there is no repo-root `go.mod`).
- The one thing the harness copies is `jcs.go` (RFC 8785), byte-identical to
  both modules' canonicalizers, so it can sign offline **grants** as the gateway
  and **proofs** as the app. Its correctness is checked at runtime: a grant it
  produces is accepted by the real controller in `TestOfflineGrant_Redeem`.

## What each test proves

| Test | Path exercised |
| --- | --- |
| `TestMoneyPath` | member open → verdict → signed `open` envelope → WS push → controller verifies vs pinned key → relay pulse → `cmd.ack` → gateway records **acked** (nonce-correlated) + clean audit row, within the 5s window |
| `TestClose_Acked` | `close` command round-trips (second actuation direction) |
| `TestOpen_NoDevice` | AP with no controller → open still audited, delivery `no_device` |
| `TestOpen_Queued` | AP bound to an offline device → delivery `queued` (poll-fallback queue) |
| `TestRateLimit_NeverReachesController` | cooldown-denied open → 429, **no** dispatch (relay never pulses, no command processed) |
| `TestControllerEvent_FlowsToGateway` | controller signs `opened` event, drains it over the WS, gateway verifies + accepts |
| `TestOfflineGrant_Redeem` | gateway-signed grant redeemed over the LAN with the gateway absent → relay pulse + `grant_redeemed` drains on the live WS |
| `TestOfflineGrant_Rejects` | adversarial grants at the real `grants.Exchange`: tampered→`badsig`, wrong device→`wrong_device`, replayed cnonce→`cnonce_replay`, each fail-closed with no pulse |
| `TestLockdown_DeniesOfflineRedeem` | lockdown latch (set via `controller-sim` stdin) denies a valid offline redemption → `lockdown`, no pulse |
| `TestPairing_PathContract` / `TestPairing_DocumentedInvocationFails` | **interop finding #1** (see below) |

## Interop findings (for the module owners)

These are documented by tests here; the fixes belong in `gateway/` /
`controller/` / `proto/`, not in this harness.

1. **Pairing redeem path mismatch (real bug).** The controller builds its redeem
   request at `<gateway>/pair/redeem` (matching `proto/pairing.md`'s flow
   diagram and the controller README's `--gateway https://host`), but the
   gateway serves the handler at **`/api/pair/redeem`** only (consistent with
   the `/api/controller/ws` it hands back). With the documented invocation the
   two never meet — the controller 404s to the portal and fails to pair. The
   `ws_url` path is fine because the gateway *provides* it; the redeem path is
   the one URL the controller constructs itself. Fix options: controller posts
   to `/api/pair/redeem`, or the gateway also mounts `/pair/redeem`, or the
   pairing.md diagram + README standardize the `/api` prefix. This suite works
   around it by passing `--gateway http://host/api`.

2. **Long-poll fallback fully mismatched (known/documented).** The controller's
   `longPollCycle` does `GET <ws_url>/../poll?device_id=…` then `POST` with
   `{acks,events}`; the gateway instead exposes `POST /api/controller/challenge`
   + `POST /api/controller/poll` (body = a signed `ws.auth`) + `POST
   /api/controller/ack`. The controller code already flags its poll endpoints as
   "not yet specced"; only the primary WebSocket path currently interoperates.
   (Not asserted here — it triggers only after 3 consecutive WS failures.)

3. **Controller events are not persisted (gap).** The gateway verifies uplink
   `event`s against the enrolled key and then only *logs* them — there is no
   event store and no API to read them back. `TestControllerEvent_FlowsToGateway`
   therefore asserts on the gateway log, the strongest observable available.

4. **No gateway API dispatches non-open/close commands (gap).** The open path is
   the only command dispatcher, so `lockdown/lift/ping/config/repair` defined in
   `proto/commands.md` have no server-side trigger. The controller's command
   verification (replay/lockdown/window/etc.) is thus unreachable from an
   external harness via the WS path; it is covered by the controller's own
   vector tests, and the lockdown *matrix* is exercised here via the offline
   grant surface instead.

5. **Provisioning coupling (not a bug, note).** The gateway signs command
   envelopes with `access_point` = the AP's **id** (a UUID), so a controller
   must be configured to *serve that id* (`--access-points <AP_ID>`), not a
   friendly name. The harness reads the id from the create-AP response and
   passes it through.
