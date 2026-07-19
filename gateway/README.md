# whatsacc gateway

The whole whatsacc server as **one Go binary**: channels, rules, portal, API,
device hub, audit — backed by **one SQLite file**. See `../ARCHITECTURE.md`
for the full picture; the Cloudflare Workers backend in `../backend/` is the
behavioral spec this is being ported from.

## Status: product core ported

The product core is ported from the Workers backend onto Go + SQLite: accounts
/ members / invites, locations / quotas, access points, devices + pairing +
the controller WebSocket hub, **the open path** (verdict → signed envelope →
device), temporary grants, and the platform-admin console. `go build ./...`,
`go vet ./...`, `go test ./...` are green (default build); `-tags portal`
builds and tests green too.

Remaining (not blocking the core): channel webhooks (WhatsApp/Telegram/Slack),
phone-OTP verify routes, analytics endpoints, maintenance/meter records +
device-fed movement metering, Google OAuth / email-verify / password-reset
ceremony, and dropping the real Vite bundle into `internal/portal/dist/`. See
the porting map below.

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

**Schema** (folded migrations, `internal/store/migrations/`):

- `0001_baseline.sql` — users, profiles, accounts, account_members, locations,
  access_points, devices, access_logs, refresh_tokens, instance_settings.
- `0002_members_invites_settings.sql` — location_members, location_settings
  (quota columns), account_invites, profile_phone_numbers (+ one-verified-owner
  unique index).
- `0003_openpath.sql` — temporary_access_grants (+ access-point join),
  rate_limit_counters, rate_limit_cooldowns.
- `0004_admin_audit.sql` — admin_audit_log.

Still deferred (ported with their routes): countries, oauth_identities,
password/email token tables, device_commands (dispatch is in-memory via the
hub for now), channel chat/message tables, maintenance_events +
access_point_meters (movement metering).

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
| `routes/auth.ts` register/login/refresh/logout/me | `internal/httpapi/auth.go` | core done (verify-email, password reset, Google OAuth, profile patch pending) |
| `routes/admin.ts` claim | `internal/httpapi/admin.go` | done |
| `routes/admin.ts` overview/accounts/users/limits(+kill-switch)/audit | `internal/httpapi/adminops.go` + `store/admin.go` | **done** |
| `routes/accounts.ts` (list/create/get/rename, members, invites) | `internal/httpapi/accounts.go` + `store/{members,invites}.go` | **done** (accept never auto-verifies phones) |
| `routes/locations.ts` (CRUD, limits/quotas, usage) | `internal/httpapi/locations.go` + `store/locations.go` | **done** |
| `routes/access.ts` access points + **open/close** + grants | `internal/httpapi/{access,open}.go` + `store/{accesspoints,openpath,grants}.go` | **done** — open path signs envelopes (`internal/keys`) and dispatches via the hub; maintenance/meters deferred |
| `lib/rate-limit.ts` | `store/ratelimit.go` + `store/openpath.go` | **done** (SQLite atomic try-bump; exact-once under concurrency) |
| `routes/devices.ts` (+ `proto/pairing.md`) | `internal/httpapi/devices.go` + `internal/hub` | **done** — claim/redeem, WS challenge/auth, ack correlation, HTTPS long-poll fallback |
| `routes/whatsapp.ts` / `slack.ts` / `telegram.ts` | `internal/channel/` seam (per ARCHITECTURE §3a) | planned |
| `routes/analytics.ts` | `internal/httpapi/analytics.go` | planned |
| `routes/phones.ts` (OTP verify) | with profile_phone_numbers migration | planned (schema + invite-side linking done; verify routes pending) |
| React portal (`../src`, Vite) | embedded via `internal/portal` (`-tags portal`) | **seam done** — placeholder default; `make portal && make build-portal` embeds the real bundle |

Backend vitest cases (unit/integration/security/contract) are ported alongside
each route group as store-level + `httptest` handler tests, including the
open-path verdict matrix and concurrency hammers.

### Device transport (Stage 2/3)

`internal/hub` is the live registry (`device_id` → WebSocket, via
`github.com/coder/websocket` — chosen over gorilla for its context-native API
and zero transitive deps). An allowed open is signed (`internal/keys`) and
pushed to the access point's controller; the reply `cmd.ack` is correlated by
envelope nonce and the outcome (`acked` / `undelivered` / `queued` /
`no_device`) is written back onto the `access_logs` row. Offline controllers
fall back to the HTTPS long-poll (`/api/controller/{challenge,poll,ack}`),
each poll gated by a single-use, signed `ws.auth` proof. `hub.VerifyAuth` is
the production twin of the `proto/vectors/pairing.json` reference verifier and
is tested against those vectors.

## Layout

```
gateway/
├── cmd/gateway/          # main: config, bootstrap, serve
├── internal/store/       # SQLite + embedded migrations + tenancy-scoped methods
│   └── migrations/       # folded baseline + 0002..0004 (SQLite)
├── internal/httpapi/     # net/http 1.22-pattern router; auth, accounts,
│                         #   locations, access, open path, devices, admin
├── internal/hub/         # device registry, ws.challenge/auth, ack correlation
├── internal/keys/        # Ed25519 identity, JCS, signed command envelopes
└── internal/portal/      # go:embed portal seam: static/ default, dist/ (-tags portal)
```

### Build modes

```sh
go build ./...                       # default: portal placeholder
make portal && make build-portal     # embed the real React bundle (-tags portal)
```

`make portal` runs `npm run build` in the repo root and copies `dist/` into
`internal/portal/dist/`; `make build-portal` then builds with `-tags portal`.
A committed `dist/index.html` placeholder keeps the tagged build compilable
before that copy runs.
