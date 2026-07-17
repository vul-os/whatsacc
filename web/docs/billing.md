# Billing & tiers

whatsacc's business model is deliberately boring: the hosted flagship charges for the
hard operational parts — Meta onboarding, our WhatsApp number, hosting, uptime — and
never for secret code. The billing engine itself ships MIT in every gateway binary,
behind a flag that is **off by default**.

## Tiers on the flagship

| | Free | Pro |
| --- | --- | --- |
| Price | R0 | **R190 / month** (≈ $10 — billed in ZAR, FX approximate) |
| Locations | 1 | More |
| Controllers | 1 | More |
| Opens | Capped per month | Unlimited |
| Channels | Flagship WhatsApp number, Slack | Same |
| Geofence, time windows, roles | Yes | Yes |
| Audit retention | 30 days | Full |
| Export & API | — | CSV export, API tokens |
| Support | Community | Priority |

> These are **placeholder launch numbers** — final tiers land with gateway 1.0. The
> portal always shows the current price before you pay anything, and the free tier is
> genuinely free: no card required.

The web portal is never capped: when a free-tier location runs out of chat opens for the
month, chat replies say so and point to the portal, which keeps working. Your gate never
becomes a hostage.

Payments on the flagship are collected with **Paystack** (cards, in rand). Cancel any
time; your data is exportable and the self-hosted exit is structural — see below.

## Self-hosting is free — actually free

A self-hosted gateway has every feature with no caps and phones home to nobody. Your
costs are your own: a VPS or a Pi, your Meta/WhatsApp fees if you bring a WABA, your
SIM if the controller runs on GSM.

## Running your *own* paid gateway

This is a feature, not a loophole. The tiering and payment code in the binary is MIT,
so a third party — an installer, a security company, a body corporate federation — can
run a commercial gateway of their own:

```sh
WACC_BILLING_ENABLED=true
WACC_BILLING_PROVIDER=paystack          # the reference provider
WACC_PAYSTACK_SECRET_KEY=sk_live_…      # YOUR keys, YOUR money
```

- Tiers, prices and caps are yours to configure in the portal's billing settings.
- Paystack is the reference `BillingProvider` implementation; the seam is small and a
  Stripe (or invoice-by-hand) provider is a reasonable contribution.
- Webhook handling fails closed: unverifiable payment webhooks are ignored and logged,
  never trusted.

Two honest notes. First, you are the merchant of record on your own gateway — taxes,
refunds and compliance are yours. Second, the whatsacc name and logo belong to the
flagship: run your paid gateway under your own brand.
