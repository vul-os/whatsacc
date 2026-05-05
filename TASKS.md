# whatsacc — Build Tasks

Tracks every piece of the system. Tick `[x]` as we land them.

---

## Open Questions (blocking schema)
- [ ] Confirm hierarchy: **Account** (billing, personal/business) → **Location** (typed: house/complex/etc., self-referential parent) → **AccessPoint** (gate)
- [ ] WhatsApp provider: Meta Cloud API / Twilio / 360dialog / other
- [ ] Device protocol: long-poll / outbound webhook / MQTT / Durable Object socket
- [ ] Frontend layout: move existing Vite/React from repo root → `/frontend/`?

---

## 0 — Foundation
- [x] `backend/` folder
- [x] `backend/cmd/migrate/` Go CLI (up / reset / seed)
- [x] `backend/migrations/` directory + initial migration
- [x] `backend/cmd/server/index.ts` Hono Worker entry
- [x] `backend/src/lib/db.ts` shared Postgres client
- [x] `.env`, `.env.dev`, `.env.main` at repo root, gitignored
- [x] `wrangler.toml` with `[env.dev]` / `[env.main]`
- [x] `package.json` (hono, postgres, wrangler) + `tsconfig.json`
- [ ] `frontend/` move (after sign-off on layout)
- [ ] Root-level scripts wiring (top-level `package.json` workspaces or just docs)

---

## 1 — Database & RLS

### Extensions / housekeeping
- [x] `pgcrypto` (uuid + crypt)
- [ ] `citext` (case-insensitive emails / slugs)

### Identity
- [ ] `users` (id, email citext UNIQUE, password_hash, status, email_verified_at, is_platform_admin, created_at)
- [ ] `profiles` (id = user.id, display_name, avatar_url, locale)
- [ ] `oauth_identities` (user_id, provider, provider_sub, email, linked_at)
- [ ] `refresh_tokens` (id, family_id, user_id, hash, expires_at, revoked_at, replaced_by)
- [ ] `password_reset_tokens` (token_hash, user_id, expires_at, used_at)
- [ ] `email_verification_tokens` (token_hash, user_id, expires_at, used_at)
- [ ] `profile_phone_numbers` (profile_id, phone_e164, verified_at, primary) + trigger enforcing max-N per profile (default 3, configurable)

### Tenancy
- [ ] `accounts` (id, name, billing_type personal|business, billing_address, status)
- [ ] `account_members` (account_id, user_id, role: owner|admin|member|viewer, status)
- [ ] `account_invites` (account_id, email, role, token_hash, expires_at, accepted_at, revoked_at)
- [ ] `locations` (id, account_id, parent_location_id NULL, type: house|complex|building|other, name, slug, address, lat, long, status)
- [ ] `location_members` (location_id, user_id, role) — overrides at location level
- [ ] `location_settings` (location_id, max_distance_m, gate_movement_m_per_op, allow_command_via_whatsapp, …)

### Access points / devices
- [ ] `access_points` (id, location_id, name, kind: gate|door|barrier, lat, long, device_id, status)
- [ ] `devices` (id, location_id, label, claim_token_hash, paired_at, last_seen_at, public_key, status)
- [ ] `device_commands` (id, device_id, access_point_id, requested_by_user_id, command: open|close, status: pending|delivered|executed|failed|expired, source: web|whatsapp|api, requested_at, delivered_at, executed_at, error)
- [ ] `access_logs` (id, access_point_id, user_id, command, source, lat, long, distance_m, success, error, ts) — denormalised for analytics

### WhatsApp
- [ ] `whatsapp_chats` (id, phone_e164 UNIQUE, profile_id NULL, last_inbound_at, last_outbound_at)
- [ ] `whatsapp_messages` (id, chat_id, direction in|out, kind text|location|media|interactive, body JSONB, provider_message_id, status, ts)

### Billing / quota
- [ ] `plans` (id, code, monthly_message_quota, included_devices, price_cents, currency)
- [ ] `account_subscriptions` (account_id, plan_id, status, current_period_start, current_period_end, cancel_at)
- [ ] `wallets` (account_id, balance_cents, currency)
- [ ] `wallet_transactions` (wallet_id, delta_cents, reason, reference, ts)
- [ ] `usage_counters` (account_id, period yyyy-mm, messages_used, opens, closes)

### RLS
- [ ] Helper: `app.current_user_id()`, `app.current_account_id()` from session GUC
- [ ] Per-table policies: tenant isolation by account_id (and location_id where stricter)
- [ ] Connection middleware sets `SET LOCAL app.user_id`, `app.account_id` from JWT each request

---

## 2 — Auth (own implementation)
- [ ] argon2id password hashing (Workers-compatible: `hash-wasm` or similar)
- [ ] JWT signing (HS256 → migrate to JWKS later)
- [ ] `POST /auth/register`
- [ ] `POST /auth/login` → access JWT + refresh token
- [ ] `POST /auth/refresh` (rotation, family invalidation on reuse)
- [ ] `POST /auth/logout` (revoke family)
- [ ] `POST /auth/forgot-password` (email link)
- [ ] `POST /auth/reset-password`
- [ ] `POST /auth/verify-email`
- [ ] `GET  /auth/google/start` (PKCE + state)
- [ ] `GET  /auth/google/callback` (link if email match, else create)
- [ ] `GET  /auth/me`
- [ ] Middleware: `requireAuth`
- [ ] Middleware: `setRLSContext`
- [ ] Email sender abstraction (Resend or SES)

---

## 3 — Members & Invites
- [ ] `GET    /accounts/:id/members`
- [ ] `POST   /accounts/:id/invites`
- [ ] `GET    /invites/:token` (pre-accept lookup)
- [ ] `POST   /invites/:token/accept`
- [ ] `DELETE /accounts/:id/invites/:inviteId`
- [ ] `PATCH  /accounts/:id/members/:userId` (role change)
- [ ] `DELETE /accounts/:id/members/:userId`

---

## 4 — Phone Numbers
- [ ] `GET    /me/phones`
- [ ] `POST   /me/phones` (issues OTP via WhatsApp)
- [ ] `POST   /me/phones/:id/verify`
- [ ] `DELETE /me/phones/:id`
- [ ] Enforce max via `location_settings.max_phones_per_profile` (or global config)

---

## 5 — WhatsApp
- [ ] Inbound webhook (provider-specific, signature verified)
- [ ] Persist inbound messages
- [ ] Outbound send helper
- [ ] Conversation flow: list available access points for the sender's linked phone
- [ ] Conversation flow: handle "open <name>" — require location share
- [ ] Distance check vs `access_points.lat/long`, reject if > `location_settings.max_distance_m`
- [ ] Enqueue `device_commands` row, ack to user
- [ ] Update `usage_counters.messages_used`

---

## 6 — Devices
- [ ] Pairing: account admin generates claim token, device exchanges for credentials
- [ ] Device transport (chosen above)
- [ ] Device reports execution (success/fail) → updates `device_commands`, writes `access_logs`
- [ ] Device heartbeat / `last_seen_at`

---

## 7 — Manual Open/Close (web)
- [ ] `GET  /access-points` (current user, filtered by membership)
- [ ] `POST /access-points/:id/open`
- [ ] `POST /access-points/:id/close`
- [ ] Same audit row in `access_logs`, `source = 'web'`

---

## 8 — Billing & Wallet
- [ ] Seed `plans` (free, starter, pro)
- [ ] Assign plan to account on signup
- [ ] Increment `usage_counters` per message processed
- [ ] On overage: draw from wallet (per-message rate); block when wallet empty
- [ ] `POST /wallet/topup` (Stripe checkout session)
- [ ] Stripe webhook → `wallet_transactions`
- [ ] `GET /accounts/:id/billing` summary

---

## 9 — Analytics
- [ ] Daily aggregate: opens/closes per location/day
- [ ] Distance moved (`opens × gate_movement_m_per_op`)
- [ ] Distinct users per location/day
- [ ] Hour-of-day histogram per location
- [ ] `GET /analytics/locations/:id/summary?from&to`
- [ ] `GET /analytics/locations/:id/heatmap`

---

## 10 — Frontend
- [ ] (Pending decision) move root Vite app → `/frontend/`
- [ ] Public landing page
- [ ] Public docs section
- [ ] Auth pages: login, register, forgot, reset, verify, Google callback
- [ ] App shell: top bar with **Open Gate** quick action when authenticated
- [ ] `/open` page: pick access point → confirm → request browser geolocation → call API
- [ ] Admin portal: members, invites, locations, access points, devices, billing, analytics
- [ ] Per-account / per-location switcher

---

## 11 — Testing
- [ ] Vitest config in `backend/`
- [ ] Unit tests for `src/lib/*`
- [ ] Integration tests against local Postgres (env-gated)
- [ ] Auth flow e2e (register → login → refresh → reset)
- [ ] WhatsApp inbound flow with sample provider payloads
- [ ] Frontend tests (Vitest + Testing Library) — login + open-gate happy path
- [ ] CI workflow (later)

---

## 12 — Ops
- [ ] Hyperdrive binding for prod (uncomment in wrangler.toml)
- [ ] Rate-limit middleware (DO-backed)
- [ ] Structured logging
- [ ] Sentry / Workers Logpush
