# Changelog

All notable changes to lintel are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

## [0.1.0] — 2026-07-21

First versioned release. lintel is a self-hosted physical access-control system:
a resident texts a chat channel (WhatsApp, Slack or Telegram), the Go gateway
checks the rules, signs an Ed25519 command, and a controller at the gate opens
it. One MIT Go binary, SQLite inside, no cloud and no billing.

This release also marks the rename from the project's former name and a
suite-wide audit that reconciled documentation, the web portal, and the gateway
against each other.

### Added
- **Gateway-side offline-grant issuance** (`POST /v1/offline-grants`) — the
  gateway now mints Ed25519-signed grants, verified byte-for-byte against the
  `proto/vectors/` conformance fixtures the controller already enforces. This
  closes three of the four pieces of the offline emergency path (contract,
  controller redemption, and gateway issuance). The phone-side app client that
  holds and presents a grant over LAN/BLE is **not yet built**, so offline
  access does not run end to end today.
- **Tamper-evident audit log** — `access_logs` and `admin_audit_log` carry a
  `prev_hash`/`row_hash` chain plus append-only database triggers that reject
  direct `UPDATE`/`DELETE`. Verify with `GET /v1/admin/audit/verify` or the
  `gateway verify-audit` CLI, which checks a cold backup without booting the
  server. Honest ceiling: the chain makes tampering *detectable*, not
  impossible — an attacker who edits the database and recomputes every
  downstream hash is not stopped by it.
- **Login brute-force protection** — per-IP and per-account rate limiting on
  `login`/`register`/`refresh`/`admin-claim`, fail-closed, structured so an
  attacker cannot cheaply lock a victim out.
- **Live session revocation** — `requireAuth` re-checks live user status per
  request; `POST /v1/auth/logout-all` revokes every refresh-token family.
- **Pluggable WhatsApp engine** — Meta Cloud API by default, with an opt-in
  self-hosted bridge engine (Evolution-API-shaped) that logs a blunt
  account-ban-risk warning on startup. The bridge is untested against a live
  instance.
- **Route-parity, feature-claim, and browser-E2E checks** in CI — a
  mechanical guard that every portal API call targets a real gateway route, a
  guard that documented features have code behind them, and a Playwright suite
  that drives the real embedded-portal binary through signup → open → audit.
- **Failure-semantics specification** for all four `proto/` wire contracts
  (partition mid-command, key rotation vs pinning, in-flight grants vs
  revocation, reconnect/clock), plus a draft DMTAP-channel binding.
- **Safety notice** in the README and a LICENSE addendum: lintel actuates
  physical barriers and must never be the sole egress path — it must run in
  parallel with code-compliant fail-safe hardware.

### Changed
- Renamed to **lintel** across the codebase, Go module path, container image,
  environment-variable prefix (`LINTEL_*`), and product site
  (`vulos.org/products/lintel`). The WhatsApp channel integration is unchanged;
  only the product name moved.
- **Web portal API client rewritten** — every call had been targeting a retired
  backend's route scheme and could not reach the shipped Go gateway (nested
  auth-token shape, Unix-seconds timestamps, `/v1` prefix). Now correct and
  guarded by the route-parity test.
- **Documentation reconciled to shipped reality** — corrected capability claims
  that described unbuilt features (geofencing, built-in TLS/ACME, CSV export,
  recurring time windows, Discord, mobile apps, webhooks) and strengthened
  claims that undersold real ones (Slack Socket Mode, Telegram, the running Go
  gateway).

### Fixed
- Channel opens were audited with the wrong source tag (Telegram/Slack visitor
  opens logged as WhatsApp).
- A signed-out user hitting `/app/*` got a permanent loading spinner instead of
  a redirect to login.
- Late controller acks now reconcile the audit row (append-only) instead of
  being dropped; an emergency open records durably before actuating; backward
  clock resets no longer bypass the stale-clock guard.

### Security
- The gateway refuses to bind a non-loopback address unless `-behind-proxy`
  (env `LINTEL_BEHIND_PROXY`) is set. The binary serves **plain HTTP** — there
  is no built-in TLS; terminate TLS in a reverse proxy. Documentation corrected
  accordingly.
- Disclosure contact and secret-file guidance corrected (the Ed25519 signing
  key and JWT secret live in the data directory, not `.env`).

[Unreleased]: https://github.com/vul-os/lintel/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/vul-os/lintel/releases/tag/v0.1.0
