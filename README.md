# whatsacc

> Texts that open gates.

whatsacc lets residents, complexes and property managers open gates, doors and barriers with a WhatsApp message — geofenced, audited, and built for trust.

A user texts `open` to a whatsacc number from WhatsApp. We verify their phone, permissions, optional location share, and any time-of-day rules, then deliver a signed open command to the paired device. The whole flow lives inside a chat thread the resident already uses every day.

---

## Architecture

```
┌──────────────────┐        ┌────────────────────┐        ┌────────────────────┐
│  WhatsApp user   │──msg──▶│  Meta Cloud API    │─────▶  │  Deno backend      │
└──────────────────┘        └────────────────────┘        │  (Hono · Postgres) │
                                                          │  · auth + RLS      │
┌──────────────────┐                                      │  · rules engine    │
│  Web admin       │──HTTP─────────────────────────────▶  │  · device dispatch │
│  (React + Vite)  │                                      └─────────┬──────────┘
└──────────────────┘                                                │
                                                                    │ signed cmd
                                                                    ▼
                                                          ┌────────────────────┐
                                                          │  Gate controller   │
                                                          │  (GSM / Wi-Fi)     │
                                                          └────────────────────┘
```

- **Postgres** is the single source of truth, with row-level security driven by JWT claims.
- **Billing in ZAR**, displayed in any of 14 currencies via FX rates (cron-refreshed).
- **WhatsApp conversation cost** varies by country — pricing model factors that in per-region.

---

## Repo layout

```
whatsacc-mono/
├── src/                       # Frontend — React 19 + Vite + TypeScript
│   ├── App.tsx, routes.tsx
│   ├── pages/                 # Landing, Pricing, Security, Login, docs/, app/
│   ├── components/            # nav, ui, landing, illustrations
│   ├── lib/                   # auth ctx, currency ctx, pricing estimate
│   └── styles/                # Tailwind v4 @theme tokens
│
├── backend/                   # Backend — Deno + Hono + postgres-js
│   ├── deno.json              # imports map + tasks
│   ├── cmd/
│   │   ├── server/main.ts     # Deno.serve entry
│   │   └── migrate/main.ts    # migration CLI (no psql shell-out)
│   ├── src/
│   │   ├── lib/               # db, env, jwt, password (argon2id), google OAuth …
│   │   ├── middleware/        # requireAuth, RLS context, error handler
│   │   └── routes/            # auth (full), accounts, locations, access,
│   │                          # devices, phones, whatsapp, billing, analytics
│   ├── migrations/            # 8 ordered .sql files — schema + RLS
│   └── tests/                 # Deno.test
│
├── billing-model/             # Python scratchpad — economics across scales
│   ├── generate.py            # one-shot script
│   └── out/                   # generated charts (PNGs)
│
├── public/                    # favicon, og.png, apple-touch-icon
├── index.html
├── package.json               # frontend deps
├── vite.config.ts
├── tsconfig*.json
├── .env / .env.dev / .env.main  # gitignored
└── TASKS.md                   # live build checklist
```

---

## Tech stack

| Layer        | Choice                                                                 |
| ------------ | ---------------------------------------------------------------------- |
| Frontend     | React 19 · Vite 8 · TypeScript · Tailwind v4 · react-router-dom 7      |
| Backend      | Deno · Hono · postgres-js · jose (JWT) · hash-wasm (argon2id) · zod    |
| Database     | Postgres 16 (Neon dev/prod)                                            |
| Auth         | Own implementation — email/password + Google OAuth + refresh rotation  |
| Tenancy      | Row-Level Security keyed off JWT claims via `SET LOCAL` GUCs           |
| Pricing      | All prices stored in **ZAR**; FX-converted for display                 |
| Billing      | Stripe (planned) · wallet-style overage                                |
| Analytics    | Python + matplotlib for the internal billing model                     |

---

## Quickstart

### Prereqs
- **Node** 20+ (frontend)
- **Deno** 1.46+ (backend)
- **Postgres** 16+ (local or Neon connection string)
- `npm`, `git`

### One-time setup

```bash
git clone <repo> whatsacc-mono
cd whatsacc-mono
npm install                                  # frontend deps

# fill in DATABASE_URL etc.
cp .env .env.local || true                   # if you'd prefer a separate file
$EDITOR .env                                 # see "Environment" below
```

### Run the database migrations

```bash
cd backend
deno task migrate                            # local (.env)
deno task migrate:dev                        # Neon dev branch (.env.dev)
deno task migrate:main                       # production (.env.main)
```

The migration CLI applies any pending `migrations/*.sql` files inside one transaction each, tracked in `public.schema_migrations`. To wipe and reapply locally:

```bash
deno run -A --env-file=../.env cmd/migrate/main.ts reset
```

### Run the backend

```bash
cd backend
deno task dev                                # watches + reloads
# server: http://localhost:8000
# health: http://localhost:8000/health
```

### Run the frontend

```bash
# from the repo root
npm run dev
# vite: http://localhost:5173
```

### Run the test suite

```bash
cd backend

# fast: pure unit tests, no DB needed
deno task test:unit

# integration + security: real local Postgres (DATABASE_URL from ../.env)
# These TRUNCATE every data table between cases. Don't point at anything you care about.
deno task test                       # everything that doesn't need external keys
deno task test:integration
deno task test:security

# contract: real third-party APIs, only run when their test keys are set
deno task test:contract              # all contract suites
deno task test:contract:paystack
deno task test:contract:resend
```

**Contract suites** hit live test endpoints at `api.paystack.co` and `api.resend.com`. Each test skips cleanly if its required env var is missing — only when the keys are present do they actually exercise the real APIs.

| Suite       | Required env                                  | What it does                                                                                                                                                       |
|-------------|-----------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `paystack`  | `PAYSTACK_SECRET_KEY` (`sk_test_...`)         | Creates + deletes recipients; initiates a R 1 transfer; charges a test card and verifies wallet credit end-to-end via the real API. Refuses to run against `sk_live_…`. |
| `resend`    | `RESEND_API_KEY` + `RESEND_TEST_TO_EMAIL`     | Sends real emails to the inbox you configure; verifies your from-domain is set up.                                                                                  |

**Side effects**:

- Paystack contract tests leave **transactions** in your test dashboard (cannot be deleted). Recipients are deleted on test completion. Transfers in test mode draw from your test balance — top up test funds in the Paystack dashboard if a transfer test reports `insufficient balance` (it auto-skips with a console warning).
- Resend contract tests deliver real emails to the inbox you set in `RESEND_TEST_TO_EMAIL`. Use a throwaway address or filter rule.

Add the test-mode key to `.env` (or set `RESEND_TEST_TO_EMAIL` directly in your shell when you want to run the resend suite ad-hoc):

```bash
# Paystack — use sk_test_… while developing.
PAYSTACK_SECRET_KEY=sk_test_xxx
PAYSTACK_PUBLIC_KEY=pk_test_xxx

# Resend
RESEND_API_KEY=re_xxx
RESEND_TEST_TO_EMAIL=ops@yourdomain.com         # only needed to run tests/contract/resend.test.ts
RESEND_TEST_FROM=whatsacc <noreply@yourdomain.com>
```

### Generate the billing-model charts

```bash
cd billing-model
python3 generate.py
# charts + data.json land in ./out/
```

---

## Environment

Three env files live at the repo root, all gitignored:

| File          | Used by                                                             |
| ------------- | ------------------------------------------------------------------- |
| `.env`        | local development (Postgres on `localhost:5432` by default)         |
| `.env.dev`    | shared dev environment (Neon dev branch)                            |
| `.env.main`   | production (Neon main, real Stripe/WhatsApp keys)                   |

Required variables (back end):

```
DATABASE_URL=postgres://user:pass@host:5432/whatsacc
APP_ENV=local
PORT=8000

JWT_SECRET=...

# Google OAuth (optional during local dev)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=

# Email
RESEND_API_KEY=                              # optional; falls back to console log

# WhatsApp Cloud API
WHATSAPP_APP_SECRET=                         # for inbound webhook signature

APP_PUBLIC_URL=http://localhost:5173
```

Selecting an env file is per-task: `deno task dev` reads `.env`; `deno task migrate:dev` reads `.env.dev`. See `backend/deno.json`.

---

## Pricing model

- All prices are stored and billed in **ZAR**.
- Display currency is a UI preference — picked in the top bar, persisted in `localStorage`.
- Conversion uses the static FX rates in `src/lib/billing/data.ts` (cron will refresh them; placeholder values today).
- WhatsApp conversation cost varies per country and is the single biggest swing factor — see `billing-model/out/sensitivity.png`.

A live estimator on `/pricing` lets a body-corp owner set residents + access points and see the monthly cost in their currency, plus a comparison list across all 15 supported countries. The pure pricing function lives in `src/lib/billing/estimate.ts` and is reused by the public estimator and (eventually) by the backend's invoice generator.

---

## Status

Live build checklist: see [`TASKS.md`](./TASKS.md). High-level state today:

- ✅ Frontend: landing, docs, pricing (with estimator), security, auth pages, full admin shell with mock data
- ✅ Backend foundations: auth (email/password + Google + refresh rotation), env config, DB pool, RLS context middleware
- ✅ Schema: 8 migrations covering identity, tenancy, devices, WhatsApp, billing + RLS policies
- ⚙️ In progress: WhatsApp inbound flow, device transport (Durable-Object-style), Stripe wallet topup, maintenance tracking
- ◯ Pending: integrating frontend with backend auth (currently stubbed), CI, deploy to Deno Deploy + Neon
