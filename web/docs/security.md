# Security

A gate is the smallest serious piece of infrastructure in your day. This chapter is how
whatsacc earns the right to open one — and it applies to every gateway alike, because
there is only one binary.

## The layers

| Layer | Mechanism |
| --- | --- |
| Command integrity | Ed25519-signed commands with nonce + expiry; the controller pins the gateway's key at pairing |
| Pairing | Claim-token flow: admin creates a claim, the device redeems it once, keys are exchanged |
| Emergency grants | Short-TTL signed capability bound to the app's keypair; nonce challenge-response |
| Channel ingress | Per-channel webhook signature verification (Meta HMAC, Slack signing secret) — fail closed |
| Tenancy | App-layer org scoping enforced on every SQLite query |
| Transport | TLS terminated by the gateway itself; tunnels stay content-blind via SNI passthrough where supported |
| Audit | Append-only event log: every open, denial, pairing and config change |

## Signed commands and key pinning

Every command a controller receives is signed by its gateway's Ed25519 key, carries a
random nonce, and expires seconds after issue. The controller learned that key exactly
once — at pairing — and pins it. The consequences are pleasant:

- A hostile network, a DNS hijack, or a malicious tunnel provider **cannot forge an
  open**. They can at worst delay traffic.
- A captured packet is a paperweight: the nonce window rejects replays, the expiry
  rejects late delivery.
- Each controller has its own keypair, generated on first boot; the private key never
  leaves the device. Losing one device never compromises another.

Because the controller dials out and verifies content, not network position, whatsacc
doesn't need to trust the path — including any tunnel you put in front.

## Geofence safety

A geofence stops people from opening your gate when they're nowhere near it. It's
optional and per-location: off by default for houses, on by default for complexes.

When enabled, every chat open must include a recent location signal — a shared location
attached to the message, or a live-location ping from the last few minutes. Outside the
radius, the gateway declines politely and writes the verdict **including the actual GPS
distance** to the audit log, so admins can investigate.

Choosing a radius:

- **50 m** — very strict; people must be at the gate already.
- **200 m** — sane default for complexes; catches most cars approaching.
- **1 km** — relaxed; for residents who text from the freeway off-ramp.

Edge cases handled explicitly:

- No location attached and geofence on → the gate stays shut and the reply asks for a
  location share.
- Spoofed GPS exists; the geofence is one meaningful layer combined with
  channel-verified identity and audit — not a magic one. That's why it's a layer, not
  the security model.
- Controller briefly offline when an open succeeds → the command is queued for a short
  window, not lost and not replayed later than its expiry.

## Emergency access, adversarially

The offline grant path is designed to add no new soft spot: the controller checks a
grant **signed by the pinned gateway key**, then a fresh nonce signed by the app key
the grant names. Neither the LAN nor Bluetooth is trusted. Revocation converges within
the grant TTL; see [Emergency access](emergency-access.md) for the full trade-off.

## What we deliberately don't claim

- whatsacc is not end-to-end encrypted messaging — chat channels are WhatsApp's and
  Slack's infrastructure, and the gateway must read messages to act on them.
- Your gateway is as secure as the machine it runs on. Back up your data
  directory; protect your `.env`.
- The audit log is append-only at the application layer; if an attacker owns the host,
  they own the SQLite file too.

## Reporting

Found something? Mail security@whatsacc.com — no sales gauntlet, just an engineer who
built it. We're happy to walk through this model with your IT team or HOA committee.
