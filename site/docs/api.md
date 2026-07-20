# API reference

The HTTP API isn't required to use lintel — most people only ever touch chat. But if
you're integrating with property-management software, wiring the gate into a home
automation, or building on top of a gateway, this is for you.

The API is served by the gateway itself — every gateway, the same way — under `/v1`.

> The `/v1` surface is stabilising alongside the Go gateway; pre-1.0, expect additive
> changes — the repository's route code is the source of truth for what exists today.

## Authentication

**Today**, the gateway only issues short-lived bearer session tokens from
`POST /v1/auth/login` / `/v1/auth/refresh` — the same tokens the portal itself uses —
sent as:

```
Authorization: Bearer <session_token>
```

**Planned**: long-lived, location-scoped, read/read-write **API tokens** issued from
the portal under **Settings → API tokens** (tracked in the repo todo), shaped like
`Authorization: Bearer lintel_live_<token>`. Until that ships, integrating means logging
in a service account and refreshing its session token like any other client.

Every gateway issues its own tokens/sessions — there is no central token authority.

## Open an access point

This one is real today, authenticated with the bearer session token from
`POST /v1/auth/login` (not a scoped `lintel_live_…` API token yet — see
[Authentication](#authentication)):

```
POST /v1/access-points/:id/open

{
  "lat": -29.858,
  "long": 31.021,
  "source": "web"
}
```

`source` is one of `web`, `whatsapp`, `api` (default `web`); `lat`/`long` are optional
unless the access point's rules demand a location signal. The request runs the same
rules pipeline as a chat message — membership, rate limits/quota — then signs and
dispatches a command to the controller. The response reports the outcome:

```
200 OK
{ "ok": true, "command": "open", "delivery": "acked" }
```

`delivery` is one of `acked`, `undelivered`, `queued` (offline, long-poll fallback) or
`no_device` (access point has no controller attached yet — the open still succeeds).
A disallowed request gets `403` (`account_suspended` / `user_disabled`) or `429`
(`rate_limited` / `quota_exceeded`, with `Retry-After`) instead of `200`.

## List events

**Not implemented as a token-scoped surface yet.** Today the audit log is readable
only through the admin console/API (`GET /v1/admin/audit`, `GET
/v1/admin/audit/actions` — instance-admin only, see [Instance admin](admin.md)), not
via a per-account, per-token events feed. A scoped `GET /v1/events` for regular API
tokens is planned alongside the API-token system below, not shipped.

## Webhooks

**Not implemented.** Outbound webhook subscriptions (`open.succeeded`, `open.denied`,
`device.offline`, `member.revoked`) are planned, tracked in the repo todo, and ship
alongside the API-token system — there is no `Settings → Webhooks` surface yet and
no HMAC-signed delivery today.

## Devices

```
GET  /v1/devices                 # controllers, their access points, online + claim state
POST /v1/devices                 # account admin: create a device + one-shot pairing claim token
```

`POST /v1/devices` is the pairing claim creation route — the same one the portal's
**Devices → Pair new** calls — see [Controllers](controllers.md) for the redemption
flow (`POST /pair/redeem`) it feeds. There is no revoke-by-DELETE endpoint yet;
revoking a controller's key is a planned admin-ops surface.

## Rate limits

1,000 requests/minute per token, soft. Opens are routed to a separate fast path and are
never denied because of rate limits.
