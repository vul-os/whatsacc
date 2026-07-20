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

## Offline redemption (LAN mDNS `_lintel._tcp` or BLE GATT)

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

## Revocation vs. in-flight grants

The whole point of this path is "no gateway involvement" — which means a
controller mid-redemption has no way to ask "has this been revoked?" and no
way to be told. This is a genuine, structural exposure window. Specify it
honestly rather than implying real-time revocation exists.

### What bounds the exposure

Only the grant's own `exp`. Default TTL is 7 days (top of this file). A
member revoked the instant after their app last refreshed a grant keeps
everything that grant authorizes — every `access_point` it lists, for the
rest of its `windows`, at any controller listing this device in `devices`
— for up to that long. There is nothing else:

- Deleting or disabling the member's account on the gateway does not reach
  an already-issued grant; the grant is a self-contained, offline-verifiable
  object (the 11-step check above touches nothing but the presented bytes
  and the controller's own pinned key / clock / lockdown state).
- The next `grant` the gateway signs for that member can simply not be
  issued, or be scoped down — but that only takes effect on the member's
  *next* refresh, and does nothing to a copy already on their device.

### What an operator must actually do to revoke fast

Latch `lockdown` on the specific controller(s) the member could reach
(commands.md `lockdown`; the verification order above denies every offline
redemption with `lockdown` while latched, exactly as it denies every live
command except `lift`/`ping`/`config`/`repair`). This is the **only**
sub-TTL lever in v0, and it is blunt on purpose: it has no notion of "this
one member" — it stops everyone, including legitimate members, until
`lift`. There is no per-member or per-grant offline deny-list; the
verification core takes no input besides the presented grant and local
controller state, by design — that locality is the feature this whole path
exists for.

### Does the controller learn of revocation on reconnect?

No. There is no message anywhere in this contract set — not here, not in
events.md, commands.md or pairing.md — that tells a controller "grant `X`
/ member `Y` is now revoked." A controller that goes offline holding no
cached deny-state and reconnects a week later has exactly the same
offline-grant behavior it had before it went offline, governed only by
each grant's own `exp`. **v0: undefined / open question.**

### Honest summary

This is a **bounded-exposure tradeoff**, not a defect to paper over:
offline-capable access control cannot also be instantly revocable without
either (a) a live channel to the controller at redemption time — which
would defeat the entire point of this path — or (b) a revocation list the
controller caches and consults while still offline. v0 has neither. If (b)
is ever wanted, treat it as a v1 proposal, not a v0 fix: it needs new wire
surface (e.g. a `revocations` list, or a per-member generation counter the
controller caches on last contact and checks against the grant's `iat`),
which this additive pass does not add.

### Implementation status

The controller side of this contract (verification, the 11-step order,
stale-clock, windows, cnonce handling) is real and conformance-tested. The
**gateway side — minting a member's `grant` object — is also real and
conformance-tested**: `POST /v1/offline-grants`
(`gateway/internal/httpapi/offline_grants.go`) authorizes the request through
the same gates the live `/open` path uses, all-or-nothing across the
requested access points, then signs the grant with
`gateway/internal/keys.SignGrant` — verified byte-for-byte against this
file's `grant-redeem-valid` vector. TTL is fixed at the 7-day default above
and is not caller-extendable.

What is **not yet implemented anywhere in this codebase is the app side**:
nothing requests, stores or presents a grant on a resident's device, so the
full end-to-end path — app holds a grant, proves it to a controller with no
gateway involved — does not run today, even though both the gateway and
controller halves are ready for it. The "refreshes on every online launch,
so revocation converges within the TTL" reasoning above describes the
intended contract; it is not yet an observable guarantee end to end,
because there is no app-side refresh loop to observe it with. **v0: gateway
+ controller real and conformance-tested; app client unbuilt.**

## Transports

The redemption messages (`grant.open` / `grant.challenge` / `grant.proof` /
`grant.result`) are transport-agnostic JSON. Two transports are specified; both
carry the identical message layer, so verification code is shared.

### LAN (primary)

Controller advertises mDNS `_lintel._tcp` (TXT: `device=<device_id>`,
`proto=0`) and serves plain HTTP on the advertised port: `POST /grant/open`
(body `grant.open`) → `grant.challenge`; `POST /grant/proof` → `grant.result`.
Plain HTTP is acceptable: every message is Ed25519-signed and single-use; the
transport adds no trust.

### BLE GATT (emergency — no network at all)

For the darkest scenario — no Wi-Fi, no LAN, phone in hand at the gate — the
controller MAY expose a BLE peripheral:

- **Service UUID** `9f0a0001-8f7c-4b62-9d5e-7acc00000001` ("lintel-grant"),
  advertised with local name `lintel-<first 8 hex of device_id>`.
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
