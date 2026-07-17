# Architecture

A condensed tour of how whatsacc fits together. The long-form version lives in the
repository's `ARCHITECTURE.md`.

## No cloud center

whatsacc has no central service that everything depends on. It is a network of
independent **gateways**: anyone can run one, whatsacc runs the flagship. Every line of
code is MIT-licensed and everything is free — there is no billing system. The only
private thing about the hosted gateway at whatsacc.com is its `.env`.

"Decentralized" here means neither federation nor P2P. It means **many independent
gateways, each a full authority** over its own tenants, numbers, devices and audit log,
with zero coordination between them. The app asks "which gateway?" on first run
(flagship pre-filled). Nothing in the system is special about the flagship except that
we run it well.

## The system at a glance

```
resident ── "open" ──► WhatsApp / Slack (Discord soon)
                              │ webhook (signature-verified)
                              ▼
        ┌──────────── GATEWAY — one Go binary · SQLite ────────────┐
        │  channel seam → rules engine → device hub → audit log    │
        │  (time windows · geofence · quotas)   (Ed25519 signing)  │
        │  embedded portal + app API                               │
        └───────────────────────┬──────────────────────────────────┘
              outbound wss ⇦ dial-out (no inbound ports at the gate)
                              │
                     controller (Wi-Fi / GSM)
                              │ verifies pinned-key signature
                              ▼
                     relay closes → 🚧 gate opens
```

The app (Tauri) talks HTTPS to the gateway for admin — and, in an emergency, talks
directly to the controller over LAN/BLE with an offline-verifiable grant
([Emergency access](emergency-access.md)).

## Components

| Component | What it is | Runs on | Stack |
| --- | --- | --- | --- |
| **gateway** | The entire server: channels, rules, portal, API, device hub, audit | Any VPS / Pi / server with a public URL | Go · SQLite · embedded portal |
| **controller** | The unit wired to the gate relay; verifies signatures, drives the motor | Pi-class board, Wi-Fi or GSM | Go agent |
| **app** | Admin console + emergency access | Desktop, iOS, Android | Svelte 5 · Tauri v2 |
| **web** | whatsacc.com — landing, docs, downloads | Any static host | Static |
| **proto** | The versioned wire contracts | — | Markdown + schemas |

## The three access paths

1. **Chat** — primary. Webhook → identity resolution → rules → signed command → in-thread
   reply. See [Chat channels](channels.md).
2. **App** — emergency. Short-TTL signed grants verified offline by the controller.
3. **Portal** — fallback. Unlimited, served by the gateway itself.

## Hosted vs. self-hosted — the WABA insight

Webhooks are easy; **the WhatsApp number is hard**. A WhatsApp channel needs a verified
Meta Business + WABA + phone number. That asymmetry is why the flagship exists: it
absorbs Meta onboarding, hosting and uptime so a household never has to. A self-hosted
gateway is the same binary with your own credentials — and Meta bills you directly, in
your own Meta account, for the conversations on your own number.

There is no billing system anywhere in whatsacc, so the honest question is who pays the
flagship's Meta conversation fees. Today: we do — the flagship is free, and its costs
are absorbed as the cost of running the reference gateway well. If that edge ever needs
funding, the direction is not subscriptions but postage in the DMTAP sense: small
prepaid, signed vouchers bought in advance and redeemed once per use at the expensive
edge, so heavy senders carry their own Meta costs and everyone else stays free. That is
a direction, not a shipped feature — nothing in the binary implements it today.

The gateway core is transport-agnostic — it binds a listener, full stop. Tunnels
(vulos-relay, cloudflared, frp) compose at the HTTP layer, so independence from any one
provider is structural, not a promise.

## The contracts that must not break

Deployed hardware is forever, so these wire contracts are versioned from day one:

1. **Pairing** — claim-token redemption, key exchange, gateway-key pinning
2. **Signed commands** — open/close/query; nonce + expiry semantics
3. **Offline grants** — grant format, challenge-response, revocation semantics
4. **Controller events** — upstream: button pressed, gate held open, tamper
5. **Tunnel** — how a gateway attaches to a reachability provider

Binaries can churn; these can only be extended.

## Tech decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Gateway language | Go | Single small static binary, ARM-friendly, embedded portal |
| Database | SQLite | Zero-dependency self-hosting; one file to back up |
| Frontend | Svelte 5 | One codebase → embedded portal + Tauri apps; small output |
| Apps | Tauri v2 | Desktop + iOS + Android from one codebase |
| Billing | None — no billing code at all | Everything is free; self-hosters pay their own providers directly |
| License | MIT, everything | The moat is running the best flagship, not hiding code |
