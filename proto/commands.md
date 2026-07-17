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

1. `sig` verifies against the pinned gateway key.
2. `device_id` matches self.
3. `iat - skew ≤ now ≤ exp` with `exp - iat ≤ 60`; allowed skew ±90s (GSM clocks drift —
   controllers sync clock from the gateway on every ping/connect).
4. `nonce` unseen within the replay window (controller stores last N=1024 nonces or
   all nonces younger than max-exp, whichever is smaller).
5. During `lockdown`, only `lift`, `ping`, `config`, `repair` are accepted.

Any failure → no actuation, log an `event` (see events.md) with the reason. Never
"open on doubt".

## Acknowledgement

```json
{ "v": 0, "typ": "cmd.ack", "nonce": "…", "result": "opened|held|closed|denied|error",
  "detail": "replay|expired|badsig|lockdown|hw:…", "ts": 1789000001,
  "sig": "base64url(ed25519(controller_key, …))" }
```

The gateway records the ack in the audit log; an unacked command past `exp` is recorded
as `undelivered` and surfaces in chat ("couldn't reach the gate — it may be offline").
