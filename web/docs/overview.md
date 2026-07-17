# whatsacc documentation

**Texts that open gates.** whatsacc is a decentralized access-control system: a chat
message — WhatsApp or Slack today, Discord soon — opens a physical gate, door or barrier.

There is no cloud center — and no hosted service. whatsacc is a network of independent
**gateways**; anyone can run one, and every gateway is somebody's own. whatsacc.com is
the project site — this landing, these docs, the downloads — not a service: there is
nothing to sign up for. Every line of code is MIT-licensed, and everything is free —
there is no billing system anywhere in whatsacc. The only private thing about any
gateway is its `.env`.

## The pieces

| Piece | What it is |
| --- | --- |
| **Gateway** | One Go binary with an embedded SQLite database. It receives chat webhooks, runs your access rules, serves the management portal and the app's API, keeps the audit log, and pushes signed commands to controllers. |
| **Controller** | The small device wired to your gate's relay. It dials *out* to the gateway over a persistent connection, verifies command signatures against a pinned key, and pulses the motor. Wi-Fi or GSM. |
| **App** | Desktop and mobile app (Tauri). It is the admin console — and the way to open your gate when the internet is down, using an offline-verifiable signed grant. |
| **Portal** | The web dashboard, embedded inside the gateway binary. No separate deployment. |

## The three ways in

1. **Chat — the primary path.** Residents text `open` from the channel they already use.
   The gateway resolves who they are, runs the rules, signs a command, replies in-thread.
2. **The app — emergency access.** Works with no internet at all: the app holds a
   short-lived grant signed by the gateway and proves itself to the controller directly
   over LAN or Bluetooth. See [Emergency access](emergency-access.md).
3. **The web portal — the fallback.** Unlimited opens through the gateway's own dashboard.

## Running it

There is one way to run whatsacc: yourself. That is the product — the whole system,
nothing held back.

- **Run a gateway** on a VPS, a Pi, or a box in the gatehouse — one binary, one SQLite
  file. Start with [Getting started](getting-started.md) or the full
  [Run a gateway](self-host.md) chapter.
- **Bring your own channel credentials.** Slack takes minutes; WhatsApp needs your own
  verified Meta business number (a WABA), and Meta bills you directly for your own
  conversations. See [Chat channels](channels.md).
- **Reachability is your choice**: a public IP with the gateway's built-in ACME, any
  tunnel you already trust running beside the binary — and, once Slack Socket Mode
  ships with the Go gateway (planned), no public URL at all. Controllers already dial
  out; today's Slack integration is the Events API webhook, so chat channels still
  need a reachable URL.

## Where to go next

- New here, want the fastest path? → [Getting started](getting-started.md)
- Self-hosting on your own hardware? → [Run a gateway](self-host.md)
- Wiring a gate? → [Controllers](controllers.md)
- Evaluating for a complex or a security review? → [Security](security.md) and
  [Architecture](architecture.md)
