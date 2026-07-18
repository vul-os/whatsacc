# Pairing — v0

How a controller becomes owned by exactly one gateway. Carries over the legacy
claim-token flow (admin creates a claim, device redeems it) and adds mutual key
exchange with gateway-key pinning.

## Flow

```
Admin (portal)                Gateway                        Controller
     │  create device          │                                 │
     ├──────────────────────▶  │                                 │
     │  claim_token (TTL ≤ 7d) │                                 │
     │◀──────────────────────  │                                 │
     │        …token entered on controller (QR / config)…        │
     │                         │   POST /pair/redeem             │
     │                         │ ◀───────────────────────────────┤
     │                         │   { claim_token,                │
     │                         │     controller_pubkey,          │
     │                         │     hw: {model, fw, ifaces} }   │
     │                         │                                 │
     │                         │   200 { device_id,              │
     │                         │     gateway_pubkey,   ← PINNED  │
     │                         │     ws_url, poll_interval }     │
     │                         ├────────────────────────────────▶│
```

## Rules

1. `claim_token` is random ≥128-bit, stored **hashed** server-side, single-use,
   expires (`claim_ttl_seconds`, default 1h, max 7d — same bounds as legacy).
2. The controller generates its Ed25519 keypair **on device** at first boot; the
   private key never leaves it.
3. The redeem response is the **only** moment the gateway public key is accepted.
   The controller persists `{device_id, gateway_pubkey, ws_url}` to durable storage
   and thereafter rejects any command or config not signed by that key.
4. Re-pairing (gateway migration, key rotation) requires a `repair` command signed by
   the **currently pinned key** (see commands.md), or a physical factory-reset.
5. After pairing the controller maintains an outbound WebSocket to `ws_url`
   (wss only), authenticating by signing a server challenge with its device key.
   Reconnect with jittered backoff; fall back to HTTPS long-poll at `poll_interval`.

## Redeem request

```json
{
  "v": 0,
  "typ": "pair.redeem",
  "claim_token": "…",
  "controller_pubkey": "base64url(ed25519-pub)",
  "hw": { "model": "wacc-c1", "fw": "0.1.0", "ifaces": ["wifi", "gsm"] }
}
```

## Redeem response

```json
{
  "v": 0,
  "typ": "pair.grant",
  "device_id": "uuid",
  "gateway_pubkey": "base64url(ed25519-pub)",
  "ws_url": "wss://gate.example.com/api/controller/ws",
  "poll_interval": 30
}
```

Both redeem messages are **unsigned**: authenticity comes from TLS plus possession
of the single-use claim token, and the response is trusted only because it arrives
on the TLS connection the controller itself opened. `controller_pubkey` /
`gateway_pubkey` are raw 32-byte Ed25519 public keys, base64url, no padding.

## WebSocket auth (the "server challenge" of rule 5)

```json
{ "v": 0, "typ": "ws.challenge", "cnonce": "base64url(128-bit random)",
  "iat": 1789000000, "exp": 1789000030 }
```

The controller answers:

```json
{ "v": 0, "typ": "ws.auth", "device_id": "uuid", "cnonce": "…", "ts": 1789000001,
  "sig": "base64url(ed25519(controller_key, JCS(message minus sig)))" }
```

Gateway verifies fail-closed: `sig` against that device's enrolled
`controller_pubkey`; `cnonce` is one it issued (`cnonce_unknown`), unexpired
(`cnonce_expired`) and single-use (`cnonce_replay`); `|ts − now| ≤ 90 s`
(`expired` / `not_yet_valid`). Reason strings are the cmd.ack `detail`
vocabulary (commands.md).
