# Emergency access

The lintel app (desktop, iOS, Android — one Tauri codebase) is deliberately **not**
the daily driver. It exists for two jobs: the admin console, and opening the gate when
everything else is down — no internet, no gateway, no Meta.

## The idea: offline-verifiable grants

Whenever the app opens with connectivity, the gateway issues it a **grant**: a
short-lived signed statement of that user's rights — which locations, which access
points, until when — bound to the app's own keypair. Think of it as a signed hall pass
that the controller can check without phoning anyone.

```
online, earlier:            gateway ── signs ──► grant (rights + expiry + app key)
internet down, at the gate: app ◄── mDNS / BLE ──► controller
                            controller: verify grant sig  (pinned gateway key)
                                        verify nonce sig  (app key)
                                        check rights + expiry
                                        ✓ open · queue audit event
```

## What happens at the gate

1. The app discovers the controller directly — **mDNS** if your phone is on the same
   LAN, or **Bluetooth (BLE)** when there's no network at all.
2. The app presents its grant and asks to open.
3. The controller replies with a random **nonce**; the app signs `grant ‖ nonce` with
   its own key.
4. The controller verifies the grant's signature against its **pinned gateway key**,
   checks expiry and rights, verifies the nonce signature against the app key named in
   the grant — and opens.
5. The audit event is queued on the controller and uploaded when connectivity returns.
   Offline opens are still audited opens.

No step involves the internet, the gateway, or any lintel server. A recorded exchange
is useless later: the nonce makes every challenge unique.

## What's implemented

The controller side of this path is **real and conformance-tested** in the reference
agent ([`controller/`](https://github.com/vul-os/lintel/tree/main/controller)): the
11-step offline-grant verification (signature, expiry, rights, single-use nonce,
stale-clock handling), shared by both transports. **LAN/mDNS works today** — the agent
advertises `_lintel._tcp` and serves grants over LAN HTTP. The **BLE** path's framing
codec and open→challenge→proof→result session are implemented and unit-tested at ATT
MTUs 23/185/512; the **BLE radio (GATT peripheral) still needs hardware validation** —
its BlueZ glue compiles behind `-tags ble` on Linux but has not been exercised on real
hardware yet.

**Gateway-side issuance is now real.** `POST /v1/offline-grants`
([`gateway/internal/httpapi/offline_grants.go`](https://github.com/vul-os/lintel/blob/main/gateway/internal/httpapi/offline_grants.go))
authenticates the caller, re-checks the exact same membership / account-suspended /
user-disabled gates the live `/open` path enforces (all-or-nothing — a caller not
currently entitled to every requested access point gets nothing, never a grant
silently narrowed to a subset they didn't notice), and signs a `typ:"grant"` object
with [`keys.SignGrant`](https://github.com/vul-os/lintel/blob/main/gateway/internal/keys/grant.go)
— the identical JCS/Ed25519 discipline `Envelope` uses, verified byte-for-byte against
[`proto/vectors/grants.json`](https://github.com/vul-os/lintel/blob/main/proto/vectors/grants.json)'s
`grant-redeem-valid` fixture. TTL is fixed at the proto default (7 days) and is not
caller-extendable, and every issuance is written to the admin audit trail. The
cross-module e2e test that exercises the LAN redemption path
(`e2e/harness_test.go` / `TestOfflineGrant_Redeem`) now calls this real endpoint
instead of self-signing a grant with the gateway's key, as it used to — the
gateway → controller half of the path is proven end to end against real issuance.

One deliberate gap: issuance does **not** check a controller's lockdown state — the
gateway has no visibility into that, by design (lockdown is controller-local; see
"that locality is the feature this whole path exists for" in `proto/grants.md`) — so a
grant can be minted while a controller happens to be in lockdown. That isn't an
oversight: lockdown is still enforced, unmodified, at redemption time (step 2 of the
controller's 11-step verification, already conformance-tested), which is the freshest
possible signal anyway — a lockdown state cached at mint time could go stale seconds
later regardless.

**What is still not built: the app.** Nothing on the phone requests, stores or
presents a grant — the Tauri app (`src/` + `src-tauri/`) ships an admin console today
and no emergency-access UI. So the path is now three pieces of four: the wire
contract, the controller-side verification, and gateway-side issuance are all real and
conformance-tested; the fourth — an app that holds a grant and proves it to a
controller over LAN/BLE — does not exist yet. A resident cannot use offline emergency
access today, because nothing on their phone can present a grant, even though the
gateway is now willing to hand one out.

## Revocation and expiry

Grants are short-TTL and refreshed whenever the app opens with connectivity. Revoking a
person therefore converges within the grant TTL at worst — and the normal, online path
checks live permissions anyway. The trade is explicit: a few hours of worst-case grant
validity buys you a gate that opens during a blackout.

Losing a phone is the same story as losing a controller: revoke the app's key in the
portal; existing grants for it die at their expiry, new ones are never issued.

## Setting it up

1. Install the lintel app and sign in to your gateway. On first run the app asks
   *which gateway* — you enter your gateway's URL. That question is the
   decentralization, made visible.
2. Grants refresh silently from then on. You can see your current grant's expiry under
   **App → Emergency access**.
3. Near the gate with no internet, open the app — the emergency screen appears
   automatically when the gateway is unreachable and a paired controller is in range.

Practical notes: BLE range is tens of meters — emergency access is a
standing-at-the-gate feature, not an open-from-the-freeway feature (that's what chat
is for). And the emergency path is for people, rate-limited by the controller; it is
not an API.
