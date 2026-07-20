# Instance admin

Every gateway has an operator: the person who runs the machine, sets the env, and
answers the phone when something breaks. lintel gives that person a real seat —
the **instance admin** — with its own claim flow, its own surfaces, and its own audit
trail. This chapter is how you claim it, what it lets you do, and exactly where its
power stops.

## Who the instance admin is

The instance admin is *not* another account role. Owners and admins live inside an
account; the instance admin stands outside all of them, at the level of the gateway
itself:

| Role | Scope | Typical person |
| --- | --- | --- |
| Member | One account — can open what they've been given | A resident, an employee |
| Account admin | Assigned locations in one account — devices, members, policies | The HOA committee member |
| Owner | One whole account — danger-zone settings, billing-free by design | Whoever signed the account up |
| Instance admin | The gateway — every account, every user, the limits, the audit | The operator running the box |

On a home install these are usually the same human wearing four hats. On a shared
gateway — one operator hosting several estates — they are different people, and the
separation matters: an account owner can never see another account, and the instance
admin's cross-account view is an explicit, audited capability, not a loophole.

## Claiming admin on first boot

A fresh gateway has no instance admin. The seat is claimed exactly once, using a
token you set in the environment:

1. Set `ADMIN_CLAIM_TOKEN` to a long random secret before starting the gateway
   (see [Run a gateway](self-host.md)).
2. Sign up and sign in as an ordinary user — the claim promotes an existing,
   active user.
3. Redeem the token, authenticated as that user:

```sh
curl -X POST https://your-gate.example/admin/claim \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"token":"'"$ADMIN_CLAIM_TOKEN"'"}'
```

A successful claim returns `{"ok":true,...}` and your user is the instance admin
from that request onward. Setup UIs can ask `GET /admin/claim` first — it returns
only `{"claimed":…,"claimable":…}`, booleans and nothing more.

The claim mechanism is deliberately unforgiving:

- **One shot, then burned.** The moment any instance admin exists — or a claim has
  ever been redeemed — the token is dead forever. It cannot be re-armed by editing
  the env; later admins are granted by the first one, not claimed.
- **Fail-closed.** No `ADMIN_CLAIM_TOKEN` in the environment means nobody can
  claim, ever. There is no default token and no fallback.
- **Constant-time comparison.** The token check leaks neither the length nor the
  position of the first wrong byte through timing.
- **Atomic under concurrency.** Two racing claims cannot both win: the claim is a
  single locked database operation with exactly one winner.
- **Every attempt is logged.** Failed claims land in the admin audit trail with the
  reason — `claim_closed`, `claim_disabled` or `invalid_claim_token` — and return
  a plain `403`.

After claiming, remove `ADMIN_CLAIM_TOKEN` from the environment. It is useless once
burned, but a dead secret in an `.env` file is still clutter.

## The operator surfaces

Everything under `/admin` (except the claim endpoints) requires an instance admin —
checked against the **live user row on every request**, never against a cached token
claim. Grant someone admin and it works on their next request; revoke it and it
stops on their next request, even if their token has hours left on it.

| Surface | Endpoints | What it does |
| --- | --- | --- |
| Overview | `GET /admin/overview` | Instance totals (users, accounts, locations, devices, access points), successful opens today and over 7 days, today's denials broken down by reason, the last ten signups |
| Accounts | `GET /admin/accounts`, `GET /admin/accounts/:id`, `PATCH /admin/accounts/:id` | List and search accounts (name, paged); drill into one — members and roles, locations, the last 25 access-log entries; suspend or unsuspend |
| Users | `GET /admin/users`, `PATCH /admin/users/:id`, `POST /admin/users/:id/platform-admin` | List and search users (email, paged) with their account memberships and last access; disable or re-enable; grant or revoke instance admin |
| Limits | `GET /admin/limits`, `PATCH /admin/limits` | Read and override the four abuse rate limits at runtime, no restart |
| Audit | `GET /admin/audit`, `GET /admin/audit/actions`, `GET /admin/audit/verify` | The cross-account access log, filterable by kind; the admin action trail; verify both tables' tamper-evident hash chains |

Cross-account reads use the same row-level scoping machinery as everything else —
the admin context is a first-class input to the *same* policies every tenant query
runs under. Tenant isolation is never switched off for anyone else so that admin
views can work.

## Suspending an account

`PATCH /admin/accounts/:id` with `{"status":"suspended"}` — and back with
`{"status":"active"}`. Suspension is scoped tightly, on purpose:

- **Opens are denied**, on every path — chat, portal, API — with the reason
  `account_suspended`. The API gets a `403`; in chat the bot says it straight:
  *"This account has been suspended by the gateway operator — the gate cannot be
  opened. Contact your operator for help."* No silent drops, no fake errors.
- **`close` still works.** Closing a gate is the safe direction and is never
  refused, suspension included.
- **Login still works.** Members and owners of a suspended account can sign in and
  see the state of their account. Suspension stops the gate from opening; it does
  not disappear people's data or lock them out of understanding why.
- Every denied open is written to the access log with `account_suspended` as the
  reason, so the history is visible to the account's own admins too.

## Disabling a user

`PATCH /admin/users/:id` with `{"status":"disabled"}` targets one person across the
whole instance:

- Their next request — any request — fails with `403 user_disabled`, because the
  auth gate re-reads the user row every time. A still-valid token buys them nothing.
- All their refresh tokens are revoked in the same transaction, so they cannot mint
  new access tokens either.
- **You cannot disable yourself**, and **you cannot disable the last active
  instance admin** — the API refuses with `cannot_disable_self` /
  `cannot_disable_last_admin` rather than let you saw off the branch you're
  sitting on.

Re-enabling is the same call with `{"status":"active"}`.

## Granting and revoking admin

`POST /admin/users/:id/platform-admin` with `{"grant":true}` or `{"grant":false}`.
Both take effect on the target's next request — no token refresh, no wait. The one
guard: **the last active instance admin cannot be revoked**
(`cannot_revoke_last_admin`). Grant a second admin first; then step down.

## Runtime rate-limit overrides

The four abuse limits from [Rate limits & quotas](limits.md) can be overridden at
runtime, without touching the env or restarting:

```sh
curl -X PATCH https://your-gate.example/admin/limits \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"opens_per_hour": 60, "open_cooldown_s": null}'
```

- Fields: `open_cooldown_s`, `opens_per_hour`, `chat_msgs_per_min`,
  `account_opens_per_hour`. Send only what you're changing.
- Resolution per field is **runtime override → env var → built-in default**.
- `null` clears an override, dropping that field back to the env value (or the
  default if the env doesn't set one).
- `GET /admin/limits` shows all four layers side by side — `defaults`, `env`,
  `overrides`, `effective` — so you can always see *why* a limit has the value it
  has.
- `0` remains a deliberate kill switch on the caps, exactly as in the env.

Overrides persist in the database and survive restarts. Every change is
audit-logged with the patch you sent and the resulting override set.

## The audit trail

Three views, all admin-only:

- **`GET /admin/audit`** — the cross-account access log: every open, close and
  denial on the instance, joined with account, location, access point and user.
  Filter with `?kind=` — `denied`, `success`, `open`, `close`, `rate_limited`,
  `quota_exceeded`, `account_suspended`.
- **`GET /admin/audit/actions`** — the admin action trail: every claim attempt
  (won or lost), suspension, user disable, admin grant or revoke, limits change,
  device create, pair redeem, invite create/accept, location create/update/
  delete, access-point create, and visitor-grant create/revoke — *and every
  denied request to `/admin/*` by a non-admin*, with the path they probed.
  Operators are watched too; that's the point.
- **`GET /admin/audit/verify`** — walks both tables' hash chains (see below) and
  reports the first row that fails to verify, if any; `200` when both chains
  check out, `409` when either doesn't.

Both audited tables are append-only at the database layer, not just by
convention: DB triggers reject any direct `UPDATE`/`DELETE` against either one
except a one-time hash-chain backfill and SQLite's own cascade nulling a foreign
key when its target is deleted. Every row is also part of a **tamper-evident hash
chain** — each row's hash covers its own content and the previous row's hash, so
editing history without redoing that work downstream breaks the chain. `GET
/admin/audit/verify` checks this live; the `gateway verify-audit` CLI subcommand
checks it against a cold backup, without booting the server at all. **This is a
detection control, not a prevention control**: an attacker who edits the SQLite
file directly and recomputes every hash after their edit leaves a chain that
still verifies clean — see [Security → Tamper-evident audit log](security.md)
for the full design and that honest limit. Mutations and their audit rows commit
in the same transaction, so a recorded action really happened and a real action
is really recorded.

## Where this fits

- [Run a gateway](self-host.md) — setting `ADMIN_CLAIM_TOKEN` and the install flow.
- [Rate limits & quotas](limits.md) — what the four limits mean and how to tune them.
- [Security](security.md) — the instance-admin trust model alongside the rest.
- [Troubleshooting](troubleshooting.md) — claim token not working, suspended
  accounts, and the locked-out-last-admin case.
