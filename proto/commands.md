# Signed commands — v0

Every actuation the controller performs is a signed envelope from its paired gateway.
Transport (WebSocket push, long-poll response, LAN relay via the app) is irrelevant to
validity — only the signature, expiry and nonce are.

## Envelope

```json
{
  "v": 0,
  "typ": "cmd",
  "cmd": "open",
  "device_id": "uuid",
  "access_point": "main",
  "nonce": "base64url(128-bit random)",
  "iat": 1789000000,
  "exp": 1789000030,
  "cause": { "kind": "chat", "channel": "whatsapp", "member": "uuid", "event": "uuid" },
  "sig": "base64url(ed25519(gateway_key, JCS(envelope minus sig)))"
}
```

Field rules:

- `cause` is **optional** (portal/scheduled commands may omit it). Optional fields
  are omitted entirely when absent — never `null` — and are covered by `sig` when
  present.
- `access_point` is **required** for `open` / `hold` / `close` and **omitted** for
  all other commands. It must name an access point this controller serves.
- Commands that carry parameters put them in an optional `payload` object, covered
  by `sig`: `config` → the params being set (e.g. `{"pulse_ms": 700}`), `repair` →
  `{"next_pubkey": "base64url(ed25519-pub)"}`, `hold` → optionally
  `{"seconds": 900}` (absent = hold until `close` / `hold_max`).

## Commands

| `cmd` | Effect | Notes |
| --- | --- | --- |
| `open` | pulse the relay for the configured duration | the one that matters |
| `hold` | hold open until `close` or `hold_max` seconds | gate-day mode |
| `close` | end a `hold` | |
| `lockdown` | refuse all opens (incl. offline grants) until `lift` | emergency freeze |
| `lift` | end lockdown | |
| `ping` | liveness + clock check; reply carries controller time | drift telemetry |
| `config` | update actuation params (pulse ms, sensor debounce, `hold_max`) | additive keys only |
| `repair` | accept a new gateway key: payload carries `next_pubkey` | key rotation; signed by the *current* pinned key |

## Verification (controller side, fail-closed)

Checked in this order; the first failure wins and is the reported reason (in
parentheses, from the `detail` vocabulary below):

1. `sig` verifies against the pinned gateway key (`badsig`).
2. `device_id` matches self (`wrong_device`); for `open`/`hold`/`close`,
   `access_point` is present and served by this controller (`wrong_access_point`).
3. `iat ≤ exp` and `exp − iat ≤ 60` (`window_too_long`), and
   `iat − skew ≤ now ≤ exp + skew` with skew = 90 s applied to **both** bounds
   (`not_yet_valid` / `expired`) — GSM clocks drift; controllers sync clock from
   the gateway on every ping/connect.
4. `nonce` never seen before (`replay`). A nonce must be remembered until its
   envelope's `exp + skew` has passed (after which step 3 rejects it anyway), so
   the store is small and bounded; 1024 slots is ample at that horizon. If the
   store ever fills with live nonces, reject new commands fail-closed rather than
   evict a live nonce.
5. During `lockdown`, only `lift`, `ping`, `config`, `repair` are accepted
   (`lockdown`).

Any failure → no actuation, log an `event` (see events.md) with the reason. Never
"open on doubt".

## Acknowledgement

```json
{ "v": 0, "typ": "cmd.ack", "device_id": "uuid", "nonce": "…",
  "result": "opened|held|closed|denied|error", "detail": "replay", "ts": 1789000001,
  "sig": "base64url(ed25519(controller_key, JCS(ack minus sig)))" }
```

`device_id` identifies the signing controller (the gateway verifies `sig` against
that device's enrolled key). `detail` is **optional** — omitted on success —
and carries a machine-readable reason from this shared vocabulary (also used by
events.md `denied` and grants.md):

`badsig | expired | not_yet_valid | window_too_long | replay | lockdown |
wrong_device | wrong_access_point | wrong_grant | window | stale_clock |
cnonce_unknown | cnonce_expired | cnonce_replay | hw:…`

The gateway records the ack in the audit log; an unacked command past `exp` is recorded
as `undelivered` and surfaces in chat ("couldn't reach the gate — it may be offline").
