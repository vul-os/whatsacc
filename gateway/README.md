# lintel gateway

The whole lintel server as **one Go binary**: channels, rules, portal, API,
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

The chat channels are now ported too: **WhatsApp, Slack (Events API + Socket
Mode) and Telegram** all funnel opens through the same open-path choke point.
See **Chat channels** below.

Remaining (not blocking the core): phone-OTP verify routes, analytics
endpoints, maintenance/meter records + device-fed movement metering, Google
OAuth / email-verify / password-reset ceremony, and dropping the real Vite
bundle into `internal/portal/dist/`. See the porting map below.

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
- `0005_channels.sql` — channel_identities (`(channel, external_id)` →
  profile), channel_chats + channel_messages (chat/message log, inbound dedupe
  via a partial unique index on `(channel, provider_message_id)`).

Still deferred (ported with their routes): countries, oauth_identities,
password/email token tables, device_commands (dispatch is in-memory via the
hub for now), maintenance_events + access_point_meters (movement metering).
(The channel chat/message tables landed in `0005_channels.sql`.)

## Chat channels

The channel seam (`internal/channels`) is deliberately small: authenticate an
inbound webhook (fail-closed), turn a message into an intent, render a reply.
Everything behind it is channel-agnostic — **every open, on every channel,
funnels through the one `store.LogAccess` choke point** (`store/openpath.go`)
the HTTP `/v1/.../open` route uses, then the same sign-and-dispatch to the
controller. A channel decides how to ask and how to reply; it never decides
whether the gate may open. Identity is keyed on `(channel, external id)`
(`channel_identities`), except WhatsApp whose identity is the **verified phone**
(`profile_phone_numbers`).

| Channel | Endpoint(s) | Auth (fail-closed) | Identity |
| --- | --- | --- | --- |
| WhatsApp | `GET/POST /webhooks/whatsapp` | `X-Hub-Signature-256` HMAC (app secret); GET verify-token handshake; `phone_number_id` filter | verified phone |
| Slack | `POST /webhooks/slack` + `/webhooks/slack/interactions`, **or Socket Mode** | signing secret, 300 s replay window (missing headers never skip); Socket Mode uses the app token | `slack_user_id` |
| Telegram | `POST /webhooks/telegram` | `X-Telegram-Bot-Api-Secret-Token` | telegram user id |

- **WhatsApp** ports the full conversational contract from
  `backend/src/routes/whatsapp.ts`: interactive **list picker** for multiple
  access points, location select, welcome / linked-locations copy, unlinked
  **signup prompt**, **visitor grants** (consume + refund-on-denial), honest
  denial replies (`rate_limited`/`quota_exceeded`/`account_suspended`/
  `user_disabled` — exact strings), message-id **dedupe**, and the flood
  throttle (bot goes quiet past the per-minute cap, webhook still `200`).
- **Slack** runs the Events API + interactions webhooks, **and Socket Mode**.
- **Telegram** — the Workers backend is an honest stub (links, logs,
  flood-throttles, replies `success`/`failed`). **This gateway wires it to the
  REAL open path**: a linked user's `open` runs the choke point, with an
  inline-keyboard picker when several gates are available and callback taps
  re-entering the same path. This **exceeds the backend stub**.

### Slack Socket Mode — the zero-URL install (ARCHITECTURE §4)

If `SLACK_APP_TOKEN` (an `xapp-…` app-level token) is configured, the gateway
**dials out** to Slack over a single outbound WebSocket instead of receiving
webhooks: `apps.connections.open` → `wss://…` → receive `events_api` /
`interactive` envelopes → ack each `envelope_id` → feed the payload through the
**same** handlers the webhook uses. A gateway on a LAN with **no public URL**
still runs Slack fully — this is what makes "a Pi on the estate LAN is a
complete installation" real. It is gated behind config (no token → no dial),
uses `github.com/coder/websocket` (the hub's existing dependency), and is
launched by `Server.StartChannels(ctx)` from `main` with automatic reconnect.

### Configuration (env, names match the backend)

```sh
# WhatsApp (Meta Cloud API)
WHATSAPP_APP_SECRET=…          # HMAC secret for POST webhooks (required to accept)
WHATSAPP_VERIFY_TOKEN=…        # GET handshake token
WHATSAPP_ACCESS_TOKEN=…        # Graph send (unset → outbound is a logged no-op)
WHATSAPP_PHONE_NUMBER_ID=…     # ours; other numbers on the WABA are ignored
WHATSAPP_GRAPH_VERSION=v21.0   # optional

# Slack
SLACK_SIGNING_SECRET=…         # required to accept webhooks (fail-closed)
SLACK_BOT_TOKEN=xoxb-…         # chat.postMessage
SLACK_APP_TOKEN=xapp-…         # OPTIONAL → enables Socket Mode (zero public URL)

# Telegram
TELEGRAM_BOT_TOKEN=…           # Bot API send
TELEGRAM_WEBHOOK_SECRET=…      # must match the secret_token you register
```

Every sender no-ops (returns a logged `…_unset` error) when its credentials are
unconfigured, so a half-configured install still records replies without
crashing — exactly the backend's behaviour.

## Build / run / test

```sh
go build ./cmd/gateway        # or: make build
go test ./...                 # or: make test
./gateway -data ./data -listen :8080
```

Config (flags override env):

| Flag | Env | Default | |
| --- | --- | --- | --- |
| `-data` | `LINTEL_DATA_DIR` | `./data` | SQLite db + keys live here |
| `-listen` | `LINTEL_LISTEN` | `:8080` | listen address |
| `-public-url` | `LINTEL_PUBLIC_URL` | — | external base URL (webhooks, links) |
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
| `routes/whatsapp.ts` / `slack.ts` / `telegram.ts` | `internal/channels/` seam + `internal/httpapi/channels_*.go` | **done** — WhatsApp full contract, Slack Events API **+ Socket Mode** (zero-URL), Telegram wired to the real open path (exceeds the backend stub) |
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
├── internal/channels/    # chat-channel seam: verify, wire parse, render, senders,
│                         #   Slack Socket Mode (coder/websocket)
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
