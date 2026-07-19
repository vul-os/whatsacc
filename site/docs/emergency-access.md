# Emergency access

The whatsacc app (desktop, iOS, Android — one Tauri codebase) is deliberately **not**
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

No step involves the internet, the gateway, or any whatsacc server. A recorded exchange
is useless later: the nonce makes every challenge unique.

## What's implemented

The controller side of this path is **real and conformance-tested** in the reference
agent ([`controller/`](https://github.com/vul-os/whatsacc/tree/main/controller)): the
11-step offline-grant verification (signature, expiry, rights, single-use nonce,
stale-clock handling), shared by both transports. **LAN/mDNS works today** — the agent
advertises `_whatsacc._tcp` and serves grants over LAN HTTP, and the cross-module e2e
harness redeems a real gateway-signed grant over the LAN with the gateway absent. The
**BLE** path's framing codec and open→challenge→proof→result session are implemented and
unit-tested at ATT MTUs 23/185/512; the **BLE radio (GATT peripheral) still needs
hardware validation** — its BlueZ glue compiles behind `-tags ble` on Linux but has not
been exercised on real hardware yet. The app (Tauri) side that pairs with it is the
remaining build. Nothing here is faked: the verification logic that decides to open is
the part that had to be right first, and it is.

## Revocation and expiry

Grants are short-TTL and refreshed whenever the app opens with connectivity. Revoking a
person therefore converges within the grant TTL at worst — and the normal, online path
checks live permissions anyway. The trade is explicit: a few hours of worst-case grant
validity buys you a gate that opens during a blackout.

Losing a phone is the same story as losing a controller: revoke the app's key in the
portal; existing grants for it die at their expiry, new ones are never issued.

## Setting it up

1. Install the whatsacc app and sign in to your gateway. On first run the app asks
   *which gateway* — you enter your gateway's URL. That question is the
   decentralization, made visible.
2. Grants refresh silently from then on. You can see your current grant's expiry under
   **App → Emergency access**.
3. Near the gate with no internet, open the app — the emergency screen appears
   automatically when the gateway is unreachable and a paired controller is in range.

Practical notes: BLE range is tens of meters — emergency access is a
standing-at-the-gate feature, not an open-from-the-freeway feature (that's what chat
and the geofence are for). And the emergency path is for people, rate-limited by the
controller; it is not an API.
