# Controllers

A controller is the unit at the gate: a Pi-class board running the whatsacc agent,
wired to the motor's relay input, on Wi-Fi or a GSM 4G SIM. It dials **out** to exactly
one gateway, verifies every command's signature against that gateway's pinned key, and
pulses the relay.

Because the connection is outbound (persistent WebSocket), a controller works behind
NAT, behind CGNAT on a prepaid SIM, and behind whatever router your complex's IT
volunteer configured in 2014. Zero inbound ports, zero port-forwarding.

## Wiring (in 30 seconds)

The controller's relay sits **in parallel** with your existing remote receiver's relay.
Find the two terminals on the gate motor that the receiver pulses — usually labelled
`COM` and `NO` — and tap into them. That's the entire wiring job:

```
gate motor        COM ──┬── existing receiver relay
                        └── whatsacc controller relay
                  NO  ──┴───────────────┘
```

- Most installs share the motor's 12&nbsp;V supply instead of the included adapter.
- For 24&nbsp;V or AC motors, use an optoisolated relay board between controller and motor.
- Your existing remotes, keypads and intercom keep working. whatsacc is in parallel,
  never in the way.

## Pairing: the claim-token flow

Pairing binds a controller to one access point on one gateway, and — critically — pins
that gateway's public signing key in the controller's storage. The flow:

1. **Admin creates a claim.** Portal → Devices → *Pair new*. Pick the access point
   (e.g. *Oakridge · Main gate*). The portal shows a short-lived claim token, as a QR
   code and as text.
2. **The device redeems it.** Give the controller the token (scan the QR with the app
   while on the controller's setup Wi-Fi, or paste it into the agent's console). The
   controller calls the gateway, redeems the claim, and the two exchange keys: the
   controller's public key is stored server-side; the gateway's public signing key is
   **pinned** on the device.
3. **Keys are fixed from here.** The claim token dies on redemption. From now on the
   controller accepts only commands signed by the pinned key — a hostile network, DNS
   hijack or malicious tunnel cannot forge an open.
4. **Test pulse.** The portal's *Send test pulse* button proves the wiring. If the gate
   moves, you're done.

LED language on the reference controller: pulsing orange — connecting; solid —
online and paired; brief green flash — command executed; red — see
[Troubleshooting](troubleshooting.md).

## Wi-Fi or GSM?

- **Wi-Fi** — free and fine when the gate is in range of a reliable network. Remember
  the gate is often the far corner of the property; test signal at the motor, not at
  the house.
- **GSM (4G SIM)** — the controller carries its own connectivity; nothing on-site can
  take it down but a dead battery. Data use is tiny (a quiet WebSocket plus commands).
  CGNAT is fine — the controller only dials out.

## Replacing and rotating

Every controller has its own keypair, generated on first boot; the private key never
leaves the device. If a controller is lost, stolen or replaced, revoke it in the portal
(its key is dead server-side within the same second) and pair its replacement with a
fresh claim. No other device on the account is touched.

## Events upstream

The signed-command contract is two-way: controllers report events upstream — command
results, button presses, gate-held-open, tamper. Result acks power the "Gate opened ·
1.8 s" replies in chat; the richer events (visitor button → "someone at the gate, reply
OPEN", held-open alerts, lockdown) are **protocol-ready now and ship as features later**.
