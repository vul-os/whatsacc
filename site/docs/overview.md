# lintel documentation

**Texts that open gates.** lintel is a decentralized access-control system: a chat
message — WhatsApp, Slack or Telegram today, Discord soon — opens a physical gate, door
or barrier.

There is no cloud center — and no hosted service. lintel is a network of independent
**gateways**; anyone can run one, and every gateway is somebody's own.
vulos.org/products/lintel is the project site — this landing, these docs, the
downloads — not a service: there is nothing to sign up for. Every line of code is MIT-licensed, and everything is free —
there is no billing system anywhere in lintel. The private things worth protecting on
any gateway are its data directory — which holds the SQLite database plus the
unencrypted Ed25519 signing key and JWT secret the gateway generates on first boot —
and its `.env` (channel credentials, and `ADMIN_CLAIM_TOKEN` before it's claimed). See
[Security](security.md) for what's actually in each.

## The pieces

| Piece | What it is |
| --- | --- |
| **Gateway** | One Go binary with an embedded SQLite database. It receives chat webhooks, runs your access rules, serves the management portal and the app's API, keeps the audit log, and pushes signed commands to controllers. |
| **Controller** | The small device wired to your gate's relay. It dials *out* to the gateway over a persistent connection, verifies command signatures against a pinned key, and pulses the motor. Wi-Fi or GSM. |
| **App** | Desktop and mobile app (Tauri). It is the admin console today; the offline emergency-open path (an offline-verifiable signed grant) is designed, and both the controller side and the gateway's issuance side are real and conformance-tested — but the app side (requesting, storing and presenting a grant) isn't built yet, so the path doesn't run end-to-end for a resident — see [Emergency access](emergency-access.md). |
| **Portal** | The web dashboard, embedded inside the gateway binary. No separate deployment. |

## The three ways in

1. **Chat — the primary path.** Residents text `open` from the channel they already use.
   The gateway resolves who they are, runs the rules, signs a command, replies in-thread.
2. **The app — emergency access (designed, not shipped end to end).** The plan: the app
   would hold a short-lived grant signed by the gateway and prove itself to the
   controller directly over LAN or Bluetooth with no internet at all. The controller
   side and the gateway's issuance side are both real and conformance-tested; the app
   doesn't request, store or present a grant yet, so nothing on a resident's phone can
   use this path today. See [Emergency access](emergency-access.md).
3. **The web portal — the fallback.** Unlimited opens through the gateway's own dashboard.

## Running it

There is one way to run lintel: yourself. That is the product — the whole system,
nothing held back.

- **Run a gateway** on a VPS, a Pi, or a box in the gatehouse — one binary, one SQLite
  file. Start with [Getting started](getting-started.md) or the full
  [Run a gateway](self-host.md) chapter.
- **Bring your own channel credentials.** Slack takes minutes; WhatsApp needs your own
  verified Meta business number (a WABA), and Meta bills you directly for your own
  conversations. See [Chat channels](channels.md).
- **Reachability is your choice**: a public IP behind your own reverse proxy or a
  TLS-terminating tunnel (the gateway itself speaks plain HTTP only — see
  [Ingress & reachability](ingress.md)), any tunnel you already trust running beside
  the binary (including a self-hosted, no-account-needed `vulos-relayd`, or the paid
  Vulos Relay convenience) — or, with
  **Slack Socket Mode (shipped)**, no public URL at all: the gateway dials out to Slack
  over a WebSocket instead of receiving webhooks. Controllers already dial out too.
  Telegram and WhatsApp still need a reachable URL today (Telegram webhook, WhatsApp's
  Cloud API is webhook-only by Meta's design) — long-polling for Telegram is on the
  roadmap. Full breakdown: [Ingress & reachability](ingress.md).

## Where to go next

- New here, want the fastest path? → [Getting started](getting-started.md)
- Self-hosting on your own hardware? → [Run a gateway](self-host.md)
- Wiring a gate? → [Controllers](controllers.md)
- Evaluating for a complex or a security review? → [Security](security.md) and
  [Architecture](architecture.md)
