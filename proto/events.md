# Controller events — v0

The upstream direction: everything the controller wants the gateway (and humans) to
know. Designed in from day one because retrofitting event flow into deployed hardware
is the painful one — the visitor button, held-open alarms and tamper detection all ride
this channel.

## Envelope

```json
{
  "v": 0,
  "typ": "event",
  "event_id": "uuid (controller-generated, idempotency key)",
  "device_id": "uuid",
  "kind": "opened",
  "ts": 1789000000,
  "data": {},
  "sig": "base64url(ed25519(controller_key, JCS(envelope minus sig)))"
}
```

Gateway verification: `sig` must verify against that `device_id`'s enrolled
controller key over `JCS(envelope minus sig)`; failures never enter the
audit-of-record (quarantine + security alert instead). `ts` is the controller's
clock and is informational — the gateway also records its own receipt time.
Dedupe is on `event_id`.

Delivery: over the standing WebSocket when connected; otherwise queued durably on the
controller (ring buffer, oldest-dropped, capacity ≥ 10k) and drained on reconnect.
Gateway dedupes on `event_id`. Offline grant redemptions are **never** dropped before
delivery — they occupy a reserved partition of the queue.

## Kinds

| `kind` | `data` | Drives |
| --- | --- | --- |
| `opened` / `closed` | `{cause: "cmd"\|"grant"\|"button", ref}` | audit log, notifications, time & attendance |
| `denied` | `{reason, ref}` — `reason` = any cmd.ack `detail` value (commands.md) | security alerting |
| `grant_redeemed` | full offline-redemption record (grant_id, cnonce, proof) | audit continuity for offline opens |
| `button` | `{button_id}` | **intercom-lite**: gateway notifies the resident's chat — "Someone is at the gate. Reply OPEN." |
| `held_open` | `{seconds}` | gate-left-open alerts (needs position sensor) |
| `tamper` | `{sensor}` | enclosure opened / supply cut alerts |
| `power` | `{source: "mains"\|"battery", level}` | battery/outage telemetry (load-shedding reality) |
| `net` | `{iface: "wifi"\|"gsm", rssi}` | connectivity telemetry, `last_seen_at` |
| `boot` | `{fw, reason}` | fleet health, update tracking |

Additive: new kinds may appear; gateways must store-and-ignore unknown kinds (they
still land in the raw audit log).
