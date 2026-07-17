# Run a gateway

The gateway is the entire server side of whatsacc: channels, rules, portal, API, device
hub and audit log — one Go binary with one SQLite file. This chapter takes you from
nothing to a reachable gateway with a channel attached.

Everything here is MIT-licensed and free. A self-hosted gateway is not a demo: it is the
same binary the flagship runs, with every feature and no caps — and no billing code in
the binary, so there is nothing to configure and nothing to pay us. Your costs are your
own: a VPS or a Pi, and Meta's per-conversation fees if you bring your own WhatsApp
number (Meta bills you directly).

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

## Reachability

The gateway binds a listener, full stop — it is transport-agnostic, and tunnels compose
at the HTTP layer. Pick whichever of these fits your life:

- **A public VPS or IP** — nothing else needed. Terminate TLS in the gateway (it can
  manage its own certificates) or behind your own reverse proxy.
- **vulos-relay** — one config line attaches the gateway to a relay tunnel; the relay
  carries traffic without terminating your TLS where SNI passthrough is available.
- **cloudflared, frp, or your own tunnel** — anything that forwards HTTPS to a local
  port works. whatsacc has no structural dependency on any one provider.

Two things need to reach the gateway from outside: **channel webhooks** (Meta, Slack)
and **your residents' portal/app sessions**. Controllers also connect here — but
they dial out from the gate side, so they work behind NAT and CGNAT'd 4G SIMs with zero
inbound ports at the gate.

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

## Moving to or from the flagship

Nothing about the flagship is special except that we run it well. Leaving it means:
stand up your own gateway, export your data from the portal, import it, re-pair your
controllers against your gateway's key. The wire contracts (pairing, commands, grants)
are versioned precisely so deployed hardware survives this.
