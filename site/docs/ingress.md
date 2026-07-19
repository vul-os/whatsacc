# Ingress & reachability

The gateway binds a listener and speaks HTTPS, full stop. It has no tunnel client
built in, no relay protocol wired into the binary, and no dependency on any vendor to
run. What you need beyond that depends entirely on which channel you attach — this
chapter is the honest, option-by-option breakdown.

## The one thing driving all of this: Meta's Cloud API is webhook-only

WhatsApp is the hard channel to reason about, precisely because of how Meta built it.
The **WhatsApp Cloud API only speaks webhooks** — Meta's servers make an outbound HTTPS
`POST` to *your* gateway every time someone messages your number. There is no
long-poll or socket alternative Meta offers; if you want WhatsApp, Meta must be able to
reach a public HTTPS URL you control. That single fact is the entire reason a
self-hosted whatsacc install might need a public endpoint at all.

Nothing else in whatsacc requires this. Controllers dial **out** to the gateway
(WebSocket), so gate hardware never needs to be reachable. And two chat channels are
designed to need no inbound connection whatsoever — see below.

## Channels that need ZERO ingress

These need nothing public at all — not a port, not a tunnel, not a domain:

- **Slack Socket Mode** — the gateway opens a single **outbound** WebSocket to Slack
  (`apps.connections.open` → dial the returned `wss://` URL) and receives every event
  over it. Slack never connects to you. Ships with the Go gateway (see
  [Chat channels](channels.md) for status); *today's* Slack integration is still the
  Events API webhook.
- **Telegram long-polling** — Telegram's Bot API supports `getUpdates` polling as an
  alternative to registering a webhook, entirely outbound, no public URL needed. It's
  the natural zero-ingress path for Telegram and is on the roadmap for this channel;
  *today* whatsacc's beta Telegram integration receives updates via webhook (see
  [Chat channels](channels.md)), so it still needs a reachable URL for now.

Once both land, a gateway on a LAN Pi with no public IP, no port-forward and no domain
name will run Slack and Telegram end to end, serve the portal on the LAN, and drive
controllers — a genuinely complete installation with nothing exposed to the internet.
Controllers already dial out today (WebSocket push, with long-poll as a fallback
transport — the `proto/` contracts are transport-agnostic by design), so they never
need ingress regardless. Only the WhatsApp channel needs a public HTTPS endpoint
unconditionally, and remote (off-LAN) portal/app access needs one if you want it.

## Getting a public HTTPS endpoint for WhatsApp (or remote portal access)

Three honest options, in the order most self-hosters reach for them:

### (a) Public bind + TLS — no tunnel, no third party

The simplest option if you already have a VPS, a static IP, or a router you can
port-forward on: point a DNS name at the box and let the gateway terminate TLS itself
(built-in ACME/Let's Encrypt), or put your own reverse proxy (nginx, Caddy, Traefik) in
front of it. Nothing else in the loop — you own the whole path from Meta to your
gateway.

- Costs: your VPS/hosting bill only.
- Trade-off: you're responsible for the box being reachable — firewall rules, port
  forwarding on CGNAT-free connections, keeping the reverse proxy patched.

### (b) Any tunnel you already trust — including self-hosted `vulos-relayd`

If your box has no public IP (home connection, CGNAT, a Pi behind a residential
router), a tunnel forwards a public HTTPS endpoint to your local gateway port. Nothing
about whatsacc is coupled to a specific tunnel — pick whichever you're already
comfortable operating:

- **cloudflared**, **frp**, **Tailscale Funnel**, **ngrok**, or your own — run it
  beside the gateway binary, point it at the local port, done.
- **`vulos-relayd`** — the open-source reverse-tunnel daemon behind Vulos Relay
  (WSS + yamux, SSRF-guarded). It's MIT-licensed and **self-hostable with no Vulos
  account and no billing relationship** — you run the daemon yourself, on your own
  relay box, the same way you'd run any other tunnel here. It's listed alongside the
  others because it happens to exist and is a solid option, not because whatsacc
  depends on it.

All of these terminate TLS at your gateway when run in passthrough mode — the tunnel
operator (including a self-hosted `vulos-relayd` box you run yourself) never sees
plaintext.

- Costs: whatever the tunnel provider charges (often free for personal use), plus your
  own compute.
- Trade-off: one more moving part to operate; outages in the tunnel take your WhatsApp
  channel down even if the gateway is healthy.

### (c) Vulos Relay — the paid convenience

If you'd rather not run and monitor a tunnel yourself, **Vulos Relay** is a hosted,
managed version of the same `vulos-relayd` software — one of the two things Vulos
actually charges for (the other being backup storage; see
[vulos.org](https://vulos.org)). Point the gateway at it the same way you'd point it at
any other tunnel, and Vulos operates the reachability fabric for you.

- Costs: a Vulos Relay subscription.
- Trade-off: none technically — it's the same tunnel model as (b), just operated for
  you. It's an *option*, never a requirement: whatsacc has no code path that assumes
  Relay exists, and every self-host guide in this repo works without it.

## Where this leaves each channel

| Channel | Ingress needed? | Notes |
| --- | --- | --- |
| Slack (Socket Mode) | **None** | Outbound WSS only — ships with the Go gateway |
| Telegram (long-polling) | **None** | Outbound HTTP polling only — roadmap for this channel |
| Slack (Events API, today's default) | Public HTTPS | Until Socket Mode ships, see [Chat channels](channels.md) |
| Telegram (webhook, today's default) | Public HTTPS | Beta; until long-polling lands, see [Chat channels](channels.md) |
| WhatsApp (Meta Cloud API) | **Public HTTPS, always** | Meta's design — see above, no way around it |
| Portal / app access from off-LAN | Public HTTPS (optional) | Only if residents/staff need it outside the property |
| Controllers | **None** | Always dial out to the gateway |

## The suite rule this follows

whatsacc has no hard runtime dependency on any Vulos product, ever — it is a
standalone, MIT-licensed system that runs to completion with nothing but a box and,
optionally, your own channel credentials. Vulos Relay shows up here strictly as one
*feature-scoped* ingress option for a single channel (WhatsApp), competing on equal
footing with cloudflared, frp, and a self-run `vulos-relayd`. Nothing breaks, degrades,
or nags you if you never touch it.

Full self-host walkthrough: [Run a gateway](self-host.md). Per-channel setup:
[Chat channels](channels.md).
