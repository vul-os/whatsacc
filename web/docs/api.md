# API reference

The HTTP API isn't required to use whatsacc — most people only ever touch chat. But if
you're integrating with property-management software, wiring the gate into a home
automation, or building on top of a gateway, this is for you.

The API is served by the gateway itself — every gateway, the same way — under `/v1`.

> The `/v1` surface is stabilising alongside the Go gateway; pre-1.0, expect additive
> changes and check the repository for the generated, always-current route list.

## Authentication

Issue tokens in the portal under **Settings → API tokens**. Tokens are scoped to
specific locations and to read or read-write.

```
Authorization: Bearer wacc_live_<token>
```

Every gateway issues its own tokens — there is no central token authority.

## Open an access point

```
POST /v1/access-points/:id/open

{
  "actor": { "channel": "api", "reference": "pm-software-tenant-42" },
  "location_signal": { "lat": -29.858, "lng": 31.021 }
}
```

The request runs the same rules pipeline as a chat message: membership, time window,
geofence (the `location_signal` is optional unless the location's geofence demands
one), quota — then a signed command to the controller. The response reports the
verdict and, when opened, the controller's acknowledgement.

## List events

```
GET /v1/events?location=loc_oak&since=2026-06-01T00:00:00Z

200 OK
{
  "events": [
    { "id": "ev_01J…", "kind": "open", "at": "2026-06-04T14:02:11Z",
      "actor": { "channel": "whatsapp", "external_id": "+27…" },
      "access_point": "ap_main", "verdict": "allowed" }
  ],
  "next": "cursor…"
}
```

Event kinds include `open`, `denied`, `paired`, `device.online`, `device.offline`,
`member.added`, `member.revoked`, `config.changed`. Everything in the audit log is
readable here, scoped to your token.

## Webhooks

Subscribe under **Settings → Webhooks** to `open.succeeded`, `open.denied`,
`device.offline` and `member.revoked`. Payloads are signed with HMAC-SHA256; verify
with the secret shown when you create the subscription. Deliveries retry with backoff
for a day, then park.

## Devices

```
GET  /v1/devices                 # controllers, their access points, online state
POST /v1/devices/claims          # create a pairing claim token
DELETE /v1/devices/:id           # revoke a controller (kills its key server-side)
```

The pairing claim created here is the same one the portal's **Devices → Pair new**
produces — see [Controllers](controllers.md) for the flow it feeds.

## Rate limits

1,000 requests/minute per token, soft. Opens are routed to a separate fast path and are
never denied because of rate limits.
