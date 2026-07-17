# Run a gateway

The gateway is the entire server side of whatsacc: channels, rules, portal, API, device
hub and audit log — one Go binary with one SQLite file. This chapter takes you from
nothing to a reachable gateway with a channel attached.

Everything here is MIT-licensed and free. Your gateway is not a demo of anything: it is
the whole system, every feature, no caps — and no billing code in the binary, so there
is nothing to configure and nothing to pay us. Your costs are your own: a VPS or a Pi,
and Meta's per-conversation fees if you run a WhatsApp channel on your own number
(Meta bills you directly).

## Install

**Docker** (recommended while pre-1.0):

```sh
docker run -d --name whatsacc \
  -p 8080:8080 \
  -v whatsacc:/data \
  ghcr.io/vul-os/whatsacc-gateway
```

**Bare binary** — grab the release for your platform (linux/amd64, linux/arm64 for a
Pi, darwin) and run it:

```sh
./whatsacc-gateway --data /var/lib/whatsacc
```

**From source**:

```sh
git clone https://github.com/vul-os/whatsacc
cd whatsacc/gateway && go build ./cmd/gateway
```

> Image and binary names are settling as the Go gateway approaches 1.0 — check the
> repository README for the current tags before scripting anything.

On first boot the gateway:

- creates `whatsacc.db` (SQLite) in its data directory,
- generates its **signing keypair** — the key controllers will pin,
- prints a one-time URL to claim the admin account in the embedded portal.

## Configuration

Configuration is environment variables (or an `.env` next to the binary). The important
ones:

| Variable | What it does |
| --- | --- |
| `WACC_PUBLIC_URL` | The URL the world reaches you at. Used for webhooks, invite links, the app. |
| `WACC_DATA_DIR` | Where `whatsacc.db` and keys live. Back this directory up. |
| `WACC_CHANNEL_*` | Per-channel credentials — see [Chat channels](channels.md). |
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
- **Any tunnel you already trust** — cloudflared, frp, Tailscale Funnel, or your own:
  anything that forwards HTTPS to a local port works, run beside the binary. whatsacc
  has no structural dependency on any provider.
- **No public URL at all** — a gateway on the estate LAN is a complete installation.
  Slack **Socket Mode** dials out to Slack (no request URL needed), Discord's bot
  gateway will dial out the same way when it lands, and controllers always dial out.
  You only need a URL for two things: **WhatsApp webhooks** (Meta must reach you) and
  **portal/app access from outside the property**.

Controllers connect to the gateway too — but they dial out from the gate side, so they
work behind NAT and CGNAT'd 4G SIMs with zero inbound ports at the gate.

## Attach a channel

Slack is the five-minute path; WhatsApp needs a verified Meta business number (WABA);
Discord is coming. All of it is covered step-by-step in [Chat channels](channels.md),
and the WABA process in detail in [Linking WhatsApp](linking-whatsapp.md).

## Backup and restore

Your entire gateway state is the data directory: `whatsacc.db` plus the key material.
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
