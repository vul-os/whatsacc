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
 │  proof {sig(app_key, grant_id‖cnonce‖access_point‖ts)}
 ├───────────────────────────────────────▶│
 │                                        │  verify: grant.sig (pinned gateway key)
 │                                        │  · exp/windows/access_point/device
 │                                        │  · proof sig (grant.app_pubkey)
 │                                        │  · cnonce fresh & single-use
 │                                        │  · not in lockdown
 │              result {opened}           │
 │◀───────────────────────────────────────┤
```

Clock rule: controllers check `exp` against their last gateway-synced clock; if the
controller has been offline longer than `2 × grant TTL`, it refuses offline redemption
entirely (stale-clock fail-closed) — chat/portal paths still work when connectivity
returns.

Every offline open is queued as an audit event and uploaded on reconnect (events.md),
including the full grant_id + proof material, so the audit trail has no offline hole.
