# Run a gateway

The gateway is the entire server side of lintel: channels, rules, portal, API, device
hub and audit log — one Go binary with one SQLite file. This chapter takes you from
nothing to a reachable gateway with a channel attached.

Everything here is MIT-licensed and free. Your gateway is not a demo of anything: it is
the whole system, every feature, no caps — and no billing code in the binary, so there
is nothing to configure and nothing to pay us. Your costs are your own: a VPS or a Pi,
and Meta's per-conversation fees if you run a WhatsApp channel on your own number
(Meta bills you directly).

## Install

> **Status — the Go gateway exists and runs today.** The single-binary Go gateway in
> [`gateway/`](https://github.com/vul-os/lintel/tree/main/gateway) implements the
> product core now: auth, accounts/locations/access-points, controller pairing and the
> WebSocket device hub, the signed open path, admin console, rate limits, and the
> WhatsApp / Slack / Telegram channels. **Building from source is the reliable path
> today** — see the commands below. Still deferred (and honest about it): the phone-OTP
> verify routes, analytics endpoints, Google OAuth / email-verify / password-reset
> ceremony, movement/meter records, and dropping the real portal bundle in for the
> placeholder. The mature Cloudflare Workers backend in `backend/` remains the
> behavioural reference the gateway is ported from.

**From source** (works today):

```sh
git clone https://github.com/vul-os/lintel
cd lintel/gateway && go build ./cmd/gateway
./gateway -data /var/lib/lintel -listen :8080
```

Pure-Go SQLite (`modernc.org/sqlite`, no CGO), so `CGO_ENABLED=0 GOARCH=arm64`
cross-compiles cleanly for a Pi.

**Docker** — build the image locally from the `Dockerfile` in `gateway/`:

```sh
cd lintel/gateway && docker build -t lintel-gateway .
docker run -d --name lintel \
  -p 8080:8080 \
  -v lintel:/data \
  lintel-gateway
```

> The `ghcr.io/vul-os/lintel-gateway` image is built by CI but **not auto-published
> yet** — its workflow is manual-only. Build locally with the `Dockerfile` above, or
> pull the published image once a release cuts it. Image and binary names are still
> settling pre-1.0 — check the repository README for current tags before scripting
> anything.

On first boot the gateway:

- creates `lintel.db` (SQLite) in its data directory,
- generates its **signing keypair** — the key controllers will pin,
- is ready for its one-shot admin claim: redeem the `ADMIN_CLAIM_TOKEN` you set in
  the environment against `POST /admin/claim` — see the next section and
  [Instance admin](admin.md).

## Claim your admin account

A fresh gateway has no operator yet. Set `ADMIN_CLAIM_TOKEN` to a long random
secret *before* first boot, sign up as an ordinary user, then redeem the token once
against `POST /admin/claim` — that user becomes the **instance admin**: the operator
seat above every account, with the overview, moderation, runtime-limits and audit
surfaces. The token works exactly once and is burned forever after any successful
claim; with the variable unset, nobody can claim at all (fail-closed). The exact
`curl`, the guarantees and everything the seat can do are in
[Instance admin](admin.md). Once claimed, remove the variable from your env.

## Configuration

Configuration is environment variables (or an `.env` next to the binary). The important
ones:

| Variable | What it does |
| --- | --- |
| `LINTEL_PUBLIC_URL` | The URL the world reaches you at. Used for webhooks, invite links, the app. |
| `LINTEL_DATA_DIR` | Where `lintel.db` and keys live. Back this directory up. |
| `WHATSAPP_*` / `SLACK_*` / `TELEGRAM_*` | Per-channel credentials (e.g. `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` for Socket Mode) — see [Chat channels](channels.md). |
| `ADMIN_CLAIM_TOKEN` | One-time secret to claim the **instance admin** seat on first run — redeemable exactly once, dead forever after; unset = nobody can claim. See [Instance admin](admin.md). |
| `RATE_OPEN_COOLDOWN_S` | Minimum seconds between successful opens per person per access point (default 10; `0` disables). |
| `RATE_OPENS_PER_HOUR` | Successful opens per member per hour (default 30; `0` = kill switch). |
| `RATE_CHAT_MSGS_PER_MIN` | Inbound chat messages per sender per minute before the bot goes quiet (default 10). |
| `RATE_ACCOUNT_OPENS_PER_HOUR` | Successful opens per account per hour — runaway-integration ceiling (default 500; `0` = kill switch). |

The four `RATE_*` variables are abuse guards, not billing — semantics, denial
behaviour and tuning advice are in [Rate limits & quotas](limits.md).

## Reachability

The gateway binds a listener, full stop — it is transport-agnostic, and tunnels compose
at the HTTP layer. Pick whichever of these fits your life:

- **A public VPS or IP** — nothing else needed. Terminate TLS in the gateway (it
  manages its own certificates via built-in ACME) or behind your own reverse proxy.
- **Any tunnel you already trust** — cloudflared, frp, Tailscale Funnel, a self-hosted
  `vulos-relayd` (open-source, no account needed), or your own: anything that forwards
  HTTPS to a local port works, run beside the binary. lintel has no structural
  dependency on any provider — **Vulos Relay** (the paid, hosted version of that same
  tunnel software) is one option among these, never a requirement.
- **No public URL at all** — a gateway on the estate LAN as a complete installation,
  and this is **real today**. Controllers dial out, and Slack **Socket Mode** ships:
  set `SLACK_APP_TOKEN` (an `xapp-…` token) and the gateway dials out to Slack over an
  outbound WebSocket with no request URL, so a LAN-only Pi runs Slack end to end.
  Discord's bot gateway will dial out the same way when it lands. Without
  `SLACK_APP_TOKEN`, Slack falls back to the **Events API** webhook (`/webhooks/slack`),
  which needs a reachable URL — as do **WhatsApp webhooks** (Meta must reach you, since
  the Cloud API is webhook-only — see [Ingress & reachability](ingress.md) for the full
  breakdown), the Telegram webhook, and **portal/app access from outside the property**.

Controllers connect to the gateway too — but they dial out from the gate side, so they
work behind NAT and CGNAT'd 4G SIMs with zero inbound ports at the gate.

## Attach a channel

Slack is the five-minute path; WhatsApp needs a verified Meta business number (WABA);
Discord is coming. All of it is covered step-by-step in [Chat channels](channels.md),
and the WABA process in detail in [Linking WhatsApp](linking-whatsapp.md). If you're
deciding whether you need a public URL at all for the channels you want, see
[Ingress & reachability](ingress.md).

## Backup and restore

Your entire gateway state is the data directory: `lintel.db` plus the key material.
Snapshot it with any file backup while the gateway is stopped, or use SQLite's online
backup against the running database. Restoring on new hardware is: place the data
directory, start the binary. Controllers reconnect on their own — the signing key they
pinned came with the data directory.

If you restore *without* the original keys, controllers will refuse the new gateway (by
design — that pinning is your defence against impersonation) and must be re-paired.

## Upgrading

The gateway migrates its SQLite schema forward automatically on boot, from a clean
folded baseline. Downgrades are not supported; take a backup before major upgrades.

## Moving between gateways

Moving your installation to a different gateway — new operator, new region, a fresh
start — means: stand up the new gateway, export your data from the old portal, import
it, re-pair your controllers against the new gateway's key. The wire contracts
(pairing, commands, grants) are versioned precisely so deployed hardware survives this.
(Moving the *same* gateway to new hardware is even easier — see backup and restore
above.)
