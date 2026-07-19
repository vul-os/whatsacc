# Offline grants — v0

Emergency access: the app can open the gate with **no internet, no gateway, no Meta** —
only the app, the controller, and math. The gateway pre-issues a signed statement of a
member's rights; the controller verifies it offline against its pinned gateway key.

## Grant (issued by gateway, refreshed whenever the app is online)

```json
{
  "v": 0,
  "typ": "grant",
  "grant_id": "uuid",
  "member": "uuid",
  "app_pubkey": "base64url(ed25519-pub)",
  "devices": ["uuid"],
  "access_points": ["main", "pedestrian"],
  "windows": [{ "days": "mon-sun", "from": "00:00", "to": "24:00" }],
  "iat": 1789000000,
  "exp": 1789604800,
  "sig": "base64url(ed25519(gateway_key, JCS(grant minus sig)))"
}
```

- TTL default **7 days**; the app refreshes on every online launch, so revocation
  converges within the TTL and is immediate on the normal (online) path.
- The grant binds the **app's own keypair** (generated on device, stored in the
  platform keystore). Possession of the grant alone is worthless.

## Offline redemption (LAN mDNS `_whatsacc._tcp` or BLE GATT)

```
App                                   Controller
 │  open {grant, access_point}            │
 ├───────────────────────────────────────▶│
 │             challenge {cnonce}         │   cnonce: 128-bit random, 30s validity
 │◀───────────────────────────────────────┤
 │  proof {grant_id, cnonce, access_point, ts, sig}
 ├───────────────────────────────────────▶│
 │                                        │  verify: see order below
 │              result {opened}           │
 │◀───────────────────────────────────────┤
```

### Redemption messages

All three are JSON. Only the proof is signed — by the app key bound in the grant,
over `JCS(message minus sig)` like every other signature in these contracts (no
raw byte concatenation).

```json
{ "v": 0, "typ": "grant.open", "grant": { "…full grant object…": "" }, "access_point": "main" }
```

```json
{ "v": 0, "typ": "grant.challenge", "cnonce": "base64url(128-bit random)",
  "iat": 1789030798, "exp": 1789030828 }
```

```json
{ "v": 0, "typ": "grant.proof", "grant_id": "uuid", "cnonce": "…",
  "access_point": "main", "ts": 1789030799,
  "sig": "base64url(ed25519(app_key, JCS(proof minus sig)))" }
```

### Verification order (controller, fail-closed — first failure wins; reasons
from the cmd.ack `detail` vocabulary, commands.md)

1. Stale-clock rule below (`stale_clock`).
2. Not in lockdown (`lockdown`).
3. `grant.sig` against the pinned gateway key (`badsig`).
4. `grant.iat − 90 ≤ now ≤ grant.exp + 90` (`not_yet_valid` / `expired`).
5. Own `device_id` ∈ `grant.devices` (`wrong_device`).
6. Requested `access_point` ∈ `grant.access_points` and equals
   `proof.access_point` (`wrong_access_point`).
7. `now` falls inside one of `grant.windows` (`window`).
8. `proof.grant_id` equals `grant.grant_id` (`wrong_grant`).
9. `proof.sig` against `grant.app_pubkey` (`badsig`).
10. `proof.cnonce` is the cnonce this controller issued for this exchange
    (`cnonce_unknown`), unexpired — `now ≤ challenge.exp`, 30 s validity
    (`cnonce_expired`) — and single-use (`cnonce_replay`).
11. `|proof.ts − now| ≤ 90` (`expired` if older / `not_yet_valid` if newer).

`windows` entries: `days` is an inclusive range of `mon|tue|wed|thu|fri|sat|sun`
in week order, no wrap-around (`"mon-sun"` = every day); `from`/`to` are `"HH:MM"`
with `to` exclusive and `"24:00"` meaning end of day. Evaluated against the
controller's gateway-synced clock in the controller's configured timezone
(default UTC).

Clock rule: controllers check `exp` against their last gateway-synced clock; if the
controller has been offline (no gateway clock sync) longer than **2 × the default
grant TTL = 14 days in v0** (a fixed constant — not derived from the presented
grant), it refuses offline redemption entirely (stale-clock fail-closed) —
chat/portal paths still work when connectivity returns.

Every offline open is queued as an audit event and uploaded on reconnect (events.md),
including the full grant_id + proof material, so the audit trail has no offline hole.

## Transports

The redemption messages (`grant.open` / `grant.challenge` / `grant.proof` /
`grant.result`) are transport-agnostic JSON. Two transports are specified; both
carry the identical message layer, so verification code is shared.

### LAN (primary)

Controller advertises mDNS `_whatsacc._tcp` (TXT: `device=<device_id>`,
`proto=0`) and serves plain HTTP on the advertised port: `POST /grant/open`
(body `grant.open`) → `grant.challenge`; `POST /grant/proof` → `grant.result`.
Plain HTTP is acceptable: every message is Ed25519-signed and single-use; the
transport adds no trust.

### BLE GATT (emergency — no network at all)

For the darkest scenario — no Wi-Fi, no LAN, phone in hand at the gate — the
controller MAY expose a BLE peripheral:

- **Service UUID** `9f0a0001-8f7c-4b62-9d5e-7acc00000001` ("whatsacc-grant"),
  advertised with local name `wacc-<first 8 hex of device_id>`.
- Characteristics:
  | UUID (`9f0a…`) | Name | Properties |
  | --- | --- | --- |
  | `…0002` | `rx` | Write / Write-without-response — app → controller frames |
  | `…0003` | `tx` | Notify — controller → app frames |
  | `…0004` | `info` | Read — JSON `{v:0, device_id, mtu}` |
- **Framing**: each JSON message is sent as one logical frame, chunked to the
  negotiated ATT MTU: 4-byte little-endian total length, then the UTF-8 JSON
  bytes, split across as many writes/notifications as needed. A new frame on
  `rx` aborts any partial previous frame. Max frame 8 KiB (`frame_too_large`).
- **Sequence**: app writes `grant.open` → controller notifies
  `grant.challenge` → app writes `grant.proof` → controller notifies
  `grant.result`. Same cnonce validity (30 s) and single-use rules; the
  controller drops the connection after result or timeout.
- **Security**: BLE pairing/bonding is NOT used or trusted — the message-layer
  Ed25519 signatures and the pinned-key model carry all authority, exactly as
  on LAN. An attacker with radio access gains nothing beyond what the LAN
  transport already exposes (deny-with-reason responses).
- Advertising SHOULD only be enabled while the gate has power and MAY be
  disabled by `config` (`ble_enabled: false`).
