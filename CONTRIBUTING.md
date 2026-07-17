# Contributing to whatsacc

Thanks for helping build texts that open gates. Small, focused PRs against `main`
are the easiest to review and land.

## Dev setup

Prereqs: **Node 20+** and **Postgres 16+** (local; no TLS needed).

```bash
git clone https://github.com/vul-os/whatsacc && cd whatsacc

npm install                      # frontend deps
cd backend && npm install && cd ..   # backend deps

cp .env.example .env             # node scripts + tests read this (repo root)
cp backend/.dev.vars.example backend/.dev.vars   # wrangler dev reads THIS

createdb whatsacc                # or point DATABASE_URL anywhere throwaway
cd backend && npm run migrate    # apply migrations
npm run dev                      # API via wrangler on :8787
cd .. && npm run dev             # Vite portal on :5173
```

Notes:

- `DATABASE_URL` and `JWT_SECRET` are **required** in both files; everything else
  (Google OAuth, Resend, WhatsApp/Telegram/Slack) is optional and degrades cleanly.
- `wrangler dev` does **not** read `.env` — it reads `backend/.dev.vars`. Keep the
  two in sync so the worker and the test/migrate scripts hit the same database.
- `npm run build` assembles the deployable `dist/` (SPA as `app.html`, marketing
  landing as `index.html`, plus `docs/`, `screenshots/`, `fonts/` — see
  `scripts/postbuild.mjs` and `firebase.json`).

## Test suites

From `backend/`:

| Command | What | Needs |
| --- | --- | --- |
| `npm run check` | TypeScript, no emit | — |
| `npm run test:unit` | pure unit tests (`tests/lib`) | — |
| `npm run test:integration` | full API against real Postgres | throwaway DB — **tables are TRUNCATEd** |
| `npm run test:security` | authz / tenancy / webhook-signature suites | same throwaway DB |
| `npm run test:contract` | real third-party APIs (Resend) | opt-in; skips cleanly without keys |

From the repo root: `npm run typecheck` and `npm run build` for the frontend.
CI (`.github/workflows/ci.yml`) runs typecheck + build, backend check + unit, and
the integration + security suites against a `postgres:16` service — a green local
run of the table above should mean green CI.

## Style

- TypeScript throughout; keep `npm run check` / `npm run typecheck` clean.
- Match the file you are editing — the codebase favors small modules, explicit
  fail-closed error handling (especially around webhooks, auth and signing), and
  comments that explain *why*, not *what*.
- No new runtime dependencies without a good reason; the long-term direction is a
  single Go binary (see [ARCHITECTURE.md](ARCHITECTURE.md)), so keep the backend
  surface portable.
- Changes to [`proto/`](proto/) are **additive-only** within a major version —
  deployed controllers are forever.
- Security-sensitive findings go to [SECURITY.md](SECURITY.md), not the issue tracker.

## License

whatsacc is [MIT](LICENSE). By contributing you agree your contributions are
licensed under the same terms. There is no CLA.
