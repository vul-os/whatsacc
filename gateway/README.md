# whatsacc gateway

The whole whatsacc server as **one Go binary**: channels, rules, portal, API,
device hub, audit — backed by **one SQLite file**. See `../ARCHITECTURE.md`
for the full picture; the Cloudflare Workers backend in `../backend/` is the
behavioral spec this is being ported from.

## Status: skeleton

This is an honest, compiling, tested skeleton that establishes the
architecture the port grows into. It is not yet a usable product server.

**Works today**

- `cmd/gateway` — flags-over-env config, first-boot data dir bootstrap
  (SQLite db, Ed25519 gateway signing key, JWT secret; all `0600/0700`), serve.
- `internal/store` — pure-Go SQLite (`modernc.org/sqlite`, no CGO, so
  `CGO_ENABLED=0` cross-compiles), embedded migrations (`go:embed`),
  **app-layer tenancy**: every tenant-data method takes an `accountID` and
  scopes its SQL to it (replaces Postgres RLS; cross-tenant reads are
  indistinguishable from not-found).
- Auth core, real not stubbed: argon2id password hashing (PHC format),
  HS256 JWT (std-lib HMAC, header pinned — no alg confusion), rotating
  refresh tokens with family reuse-detection.
  `POST /v1/auth/{register,login,refresh,logout}`, `GET /v1/auth/me`.
- One-shot instance-admin claim per the backend's semantics:
  `GET|POST /v1/admin/claim` — fail-closed when `ADMIN_CLAIM_TOKEN` is unset,
  constant-time token compare, atomic win, burned permanently via the
  `admin_claimed` flag in `instance_settings`.
- `internal/keys` — gateway Ed25519 identity generated at first boot,
  `GET /v1/gateway/key`, and signed command envelopes per
  `../proto/commands.md` (nonce, iat/exp with the 60 s cap, JCS
  canonicalization).
- `internal/portal` — `go:embed` seam serving a placeholder page at `/`;
  the Svelte portal bundle drops in here later.
- `GET /health` → `{"ok":true,"version":...}`.

**JCS note**: `../proto/vectors/` did not exist when this was written, so
`internal/keys/jcs.go` implements an RFC 8785 subset with self-authored test
vectors. Documented deviation: general (non-integer) number formatting is
rejected rather than implemented — envelopes only carry integers and strings.
When `proto/vectors/` lands, point the tests at it and extend if needed.

**Schema subset** (`internal/store/migrations/0001_baseline.sql`): users,
profiles, accounts, account_members, locations, access_points, devices,
access_logs, refresh_tokens, instance_settings. Deferred (listed in the
migration header): countries, oauth_identities, password/email token tables,
profile_phone_numbers, account_invites, location_members, location_settings,
device_commands, all channel chat/message tables, maintenance/meters,
temporary_access_grants, rate-limit tables, admin_audit_log.

## Build / run / test

```sh
go build ./cmd/gateway        # or: make build
go test ./...                 # or: make test
./gateway -data ./data -listen :8080
```

Config (flags override env):

| Flag | Env | Default | |
| --- | --- | --- | --- |
| `-data` | `WACC_DATA_DIR` | `./data` | SQLite db + keys live here |
| `-listen` | `WACC_LISTEN` | `:8080` | listen address |
| `-public-url` | `WACC_PUBLIC_URL` | — | external base URL (webhooks, links) |
| `-admin-claim-token` | `ADMIN_CLAIM_TOKEN` | — | one-shot admin claim; empty = claiming disabled |

First-boot claim flow: register a user, then
`POST /v1/admin/claim {"token": "<ADMIN_CLAIM_TOKEN>"}` with that user's
bearer token. Exactly one caller can ever win; the mechanism burns forever.

## Porting map (backend route → gateway package)

| Backend (spec) | Gateway | Status |
| --- | --- | --- |
| `routes/auth.ts` register/login/refresh/logout/me | `internal/httpapi/auth.go` | skeleton (core done; verify-email, password reset, Google OAuth, invites, profile patch pending) |
| `routes/admin.ts` claim | `internal/httpapi/admin.go` | done |
| `routes/admin.ts` overview/accounts/users/limits/audit | `internal/httpapi/admin.go` | planned (needs admin_audit_log + rate-limit tables) |
| `routes/accounts.ts` | `internal/httpapi/accounts.go` | planned |
| `routes/locations.ts` | `internal/httpapi/locations.go` | planned |
| `routes/access.ts` (access points, open/close, grants, maintenance) | `internal/httpapi/access.go` + rules engine pkg | planned — open path emits signed envelopes via `internal/keys` |
| `routes/devices.ts` (+ `proto/pairing.md`) | `internal/httpapi/devices.go` + device hub (wss dial-out) | planned |
| `routes/whatsapp.ts` / `slack.ts` / `telegram.ts` | `internal/channel/` seam (per ARCHITECTURE §3a) | planned |
| `routes/analytics.ts` | `internal/httpapi/analytics.go` | planned |
| `routes/phones.ts` | with profile_phone_numbers migration | planned |
| React portal (`../src`) | Svelte build embedded via `internal/portal` | placeholder seam wired |

Backend vitest cases (unit/integration/security/contract) get ported alongside
each route group.

## Layout

```
gateway/
├── cmd/gateway/          # main: config, bootstrap, serve
├── internal/store/       # SQLite + embedded migrations + tenancy-scoped methods
│   └── migrations/       # clean folded baseline (SQLite)
├── internal/httpapi/     # net/http 1.22-pattern router, auth, admin claim
├── internal/keys/        # Ed25519 identity, JCS, signed command envelopes
└── internal/portal/      # go:embed portal seam (placeholder page)
```
