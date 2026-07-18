<div align="center">

<img src="public/favicon.svg" width="88" alt="whatsacc — arch mark" />

# whatsacc

**Texts that open gates.**

Open physical gates, doors and barriers from the chat apps people already use —
WhatsApp first, Slack today, Discord soon. Geofenced, audited, built for trust.

[![License: MIT](https://img.shields.io/badge/license-MIT-1a1f36.svg)](LICENSE)
[![Architecture](https://img.shields.io/badge/read-ARCHITECTURE.md-d6624d.svg)](ARCHITECTURE.md)
[![Part of Vulos](https://img.shields.io/badge/suite-vulos.org-2c5f4f.svg)](https://vulos.org)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="site/screenshots/dark/portal-dashboard.png" />
  <img src="site/screenshots/portal-dashboard.png" width="840" alt="The whatsacc management portal — tap-to-open access points, live activity" />
</picture>

</div>

---

There is **no cloud center**. whatsacc is a decentralized network of independent
**gateways**: a gateway is one MIT-licensed Go binary (SQLite inside, management portal
embedded) that anyone can run — a VPS, a Pi in the guardhouse, anywhere with a public
URL. There is **no hosted service and no billing system** — whatsacc.com is the project
site, not a cloud. You bring your own WhatsApp number or Slack workspace; Meta bills you
directly for your own conversations. Operators who want to charge their residents solve
that outside the system.

```mermaid
flowchart LR
    R["🧍 Resident"] -- "“open”" --> CH["WhatsApp · Slack · Discord soon"]
    CH --> GW["Gateway<br/>one Go binary · SQLite<br/>rules · portal · audit"]
    APP["📱 App (Tauri)<br/>admin + emergency"] --> GW
    GW -- "signed command<br/>(outbound wss)" --> C["Controller at the gate<br/>Wi-Fi / GSM 4G"]
    C --> G["🚧 Gate opens"]
    APP -. "internet down?<br/>LAN/BLE offline grant" .-> C
```

## Three ways in

Ranked by how people actually behave:

1. **Chat** — text `open` to the gateway's number or bot. The rules engine checks
   identity, location, access point, time windows and quotas, then pushes an
   Ed25519-signed command to the controller. Multiple access points? You get a
   numbered picker in the thread.
2. **The app** — emergency access that works **when the internet is down**: the gateway
   pre-issues short-lived signed grants; the app proves them to the controller directly
   over LAN/BLE with a nonce challenge. Also the admin console.
3. **Web portal** — unlimited fallback, always.

The full design — components, security model, wire contracts, hosted-vs-self-hosted
economics — lives in **[ARCHITECTURE.md](ARCHITECTURE.md)**. The wire contracts that
controllers and apps depend on are versioned in [`proto/`](proto/).

## A look around

| Access points & controllers | Analytics |
| :---: | :---: |
| <picture><source media="(prefers-color-scheme: dark)" srcset="site/screenshots/dark/portal-locations.png" /><img src="site/screenshots/portal-locations.png" alt="Access points — controllers, maintenance windows, meters" /></picture> | <picture><source media="(prefers-color-scheme: dark)" srcset="site/screenshots/dark/portal-analytics.png" /><img src="site/screenshots/portal-analytics.png" alt="Analytics — opens per day, per access point, active members" /></picture> |

| Tap-to-open (mobile) | Landing |
| :---: | :---: |
| <picture><source media="(prefers-color-scheme: dark)" srcset="site/screenshots/dark/app-emergency.png" /><img src="site/screenshots/app-emergency.png" width="270" alt="Mobile tap-to-open gate view" /></picture> | <picture><source media="(prefers-color-scheme: dark)" srcset="site/screenshots/dark/landing-hero.png" /><img src="site/screenshots/landing-hero.png" alt="whatsacc.com landing" /></picture> |

Every screenshot above is generated, not hand-made — light **and** dark, from the real
app with realistic data:

```bash
npm run screenshotter   # boots the app with mocked data → site/screenshots/{,dark/}
```

## Monorepo

| Directory     | What                                                             | Status |
| ------------- | ---------------------------------------------------------------- | ------ |
| `site/`       | Landing + 14-chapter docs — house mini-site format, self-contained, light/dark | ✅ |
| `proto/`      | Versioned wire contracts: pairing, signed commands, offline grants, events | ✅ v0 draft |
| `backend/`    | Current API — Cloudflare Workers · Postgres RLS · WhatsApp + Slack | ✅ running, **spec for the Go port** |
| `src/`        | Portal application — React 19 · Vite · light/dark, wrapped as a desktop app by `src-tauri/` (Tauri desktop shell, in progress) | ✅ running |
| `scripts/`    | `screenshotter` — Playwright product shots with fixture data     | ✅ |
| `gateway/`    | Go single-binary gateway — SQLite, auth core, admin claim, signed envelopes | 🚧 skeleton, porting from `backend/` |
| `controller/` | Gate device agent + reference wiring                             | 🔨 planned |
| `app/`        | Svelte 5 + Tauri v2 — admin console + offline emergency access   | 🔨 planned |

The running stack is the behavioral reference: its routes, tenancy semantics, chat
flows and test suites define what the Go gateway must do.

## Quickstart (current stack)

Prereqs: Node 20+, Postgres 16+ (local).

```bash
npm install                     # frontend deps
cd backend && npm install       # backend deps
cd ..

cp .env.example .env            # read by migrate/seed/test scripts (node --env-file)
cp backend/.dev.vars.example backend/.dev.vars   # read by `wrangler dev` (NOT .env)
# → set DATABASE_URL + JWT_SECRET in BOTH; everything else is optional

cd backend
npm run migrate                 # apply migrations (DATABASE_URL from ../.env)
npm run dev                     # API via wrangler on :8787 (env from .dev.vars)
cd .. && npm run dev            # Vite portal on :5173
```

Tests, from `backend/`:

```bash
npm run check                   # tsc
npm run test:unit               # pure unit tests, no DB
npm run test:integration        # real local Postgres — TRUNCATEs tables, use a throwaway DB
npm run test:security           # authz / RLS / webhook-signature suites
npm run test:contract           # opt-in: real Resend test API when keys are set
```

Contract suites skip cleanly without keys — see [`site/docs/`](site/docs/) for details.

## Docs

The full documentation ships in this repo at [`site/docs/`](site/docs/) — getting
started, linking WhatsApp, running your own gateway, channels, controllers and pairing,
offline emergency access, security model, API reference, troubleshooting. `site/` is a
plain static site — host it anywhere; it also syncs into the
[Vulos console](https://vulos.org/products/whatsacc/docs) as the product mini-site.

## Part of the Vulos suite

whatsacc is a standalone open-source product in the [Vulos](https://vulos.org) suite —
sovereign software you can run yourself. Reachability stays simple: a public IP with
built-in ACME, or any tunnel you already trust (cloudflared, frp) beside the binary.
On a LAN with Slack Socket Mode, no public URL is needed at all.

## Contributing & security

Dev setup, test suites and style live in [CONTRIBUTING.md](CONTRIBUTING.md).
Vulnerabilities — this product opens physical gates — go privately via
[SECURITY.md](SECURITY.md), never the public tracker.

## License

[MIT](LICENSE) — all of it: gateway, portal, app, controller agent. No cloud, no
billing system, no paid features. Just the system.
