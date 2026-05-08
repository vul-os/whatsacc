#!/usr/bin/env python3
"""
whatsacc — billing-model scratchpad.

Generates revenue / cost / profit charts at user scales (10 → 100k), factoring:
  · WhatsApp Cloud API conversation costs (with Meta's 1000-free-tier)
  · GSM data plans for the controller devices
  · Hosting (Deno Deploy + Neon Postgres)
  · Stripe processing fees
  · Per-user revenue assumptions (with enterprise discount above N users)

All numbers are planning estimates — tune the Assumptions block at the top.

Run:   python3 generate.py
Out:   ./out/*.png  +  ./out/data.json
"""

from dataclasses import dataclass, asdict, replace, field
from pathlib import Path
from typing import List, Tuple
import json

try:
    import matplotlib.pyplot as plt
    import numpy as np
    HAVE_PLOT = True
except ImportError:
    plt = None
    np = None
    HAVE_PLOT = False

# ── Brand palette ────────────────────────────────────────────────────────────
INK = '#1A1F36'
PAPER = '#F4EDE2'
PAPER_WARM = '#ECE2D1'
TERRACOTTA = '#D6624D'
MOSS = '#4A6B58'
SLATE = '#6B7188'
GOLD = '#C8A45C'
CLAY = '#CAB39A'

# ── Assumptions ──────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Assumptions:
    # User behaviour ──────────────────────────────────────────────────────────
    # ~1.3 opens/day on avg blends heavy users (4-5/day) with light users (~3/wk).
    opens_per_user_month: float = 40.0      # all gate opens (WhatsApp + portal)
    msgs_per_conversation: float = 4.0      # greet, location, list, pick, confirm

    # Web portal substitution ────────────────────────────────────────────────
    # "Infinite access via web portal" is the headline. A material fraction of
    # opens happen through the portal (no Meta cost). Conservative default 30%.
    portal_substitution: float = 0.30

    # Topology
    users_per_device: float = 50.0          # residents per gate
    devices_per_location: float = 5.0       # gates per paying account/location

    # WhatsApp Cloud API (Meta) ───────────────────────────────────────────────
    # Service conversations are user-initiated; for whatsacc that's nearly all of them.
    # Meta's blended service rate runs ~$0.005 (ZA, IN) → ~$0.025 (US, EU).
    whatsapp_cost_per_conversation: float = 0.006
    # Meta's free tier is per WABA, not per customer. We assume one WABA per
    # region, so the free pool is amortised across that region's customers and
    # is effectively zero at any non-trivial scale. Set to 0 to avoid distorting
    # small-account economics.
    free_conversations_per_business_month: int = 0

    # Server / DB ─────────────────────────────────────────────────────────────
    server_cost_per_msg: float = 0.00015    # Cloudflare Workers req cost amortised
    db_cost_per_user_month: float = 0.004   # Neon Postgres at scale

    # GSM data per controller device ──────────────────────────────────────────
    device_gsm_cost_per_month: float = 4.0  # IoT SIM, low-volume
    device_other_cost_per_month: float = 0.5  # hardware amort, ops overhead

    # Fixed monthly (independent of scale) ───────────────────────────────────
    fixed_hosting: float = 35.0             # Workers + Neon base
    fixed_monitoring: float = 30.0          # Sentry / logs / uptime
    fixed_misc: float = 20.0                # domain, mail, etc

    # Revenue ─────────────────────────────────────────────────────────────────
    arpu: float = 1.50                      # currency-units / active resident / month
    enterprise_user_threshold: int = 5000   # at >= this, ARPU drops
    enterprise_arpu: float = 1.00           # negotiated rate
    base_subscription_per_location: float = 19.0  # min floor per paying account

    # Paystack (replaces Stripe) ──────────────────────────────────────────────
    # Per-region: ZA local 2.9% + R1; international cards 3.5%; NG 1.5% capped.
    # Defaults below are blended international, in USD; per-region values
    # override these via Region.fee_pct / Region.fee_fixed.
    fee_pct: float = 0.035
    fee_fixed_per_charge: float = 0.20

    # Resend (transactional email) ────────────────────────────────────────────
    # Pro plan starts at $20/mo for 50k emails; per-email amortised ~ $0.0004.
    resend_fixed_monthly: float = 20.0       # base plan
    resend_per_email: float = 0.0004
    resend_included_per_month: int = 50_000
    # Heuristic: ~3 transactional emails per active user per month.
    emails_per_user_per_month: float = 3.0



# ── Regions ──────────────────────────────────────────────────────────────────

# Each region overrides the WhatsApp cost + revenue assumptions in `Assumptions`.
# WhatsApp service-conversation rates are public on Meta's pricing page; ARPU and
# floor pricing are PPP-style adjustments to reflect what local body corporates
# can plausibly pay.


@dataclass(frozen=True)
class Region:
    code: str                         # short identifier for charts / data
    name: str                         # human-readable label
    countries: Tuple[str, ...]        # ISO 3166-1 alpha-2 codes
    currency: str                     # billing currency code
    whatsapp_cost_per_conversation: float
    arpu: float                       # local ARPU, denominated in the region's currency
    enterprise_arpu: float
    base_subscription_per_location: float
    fx_to_usd: float                  # multiplier to convert region currency → USD for charts
    # Paystack fees (in local currency)
    fee_pct: float                    # 0.029 = 2.9%
    fee_fixed_per_charge: float       # local currency
    # Wallet / PAYG per-open price (local currency).  Drives top-up overage.
    payg_open_price: float
    color: str


REGIONS: Tuple[Region, ...] = (
    Region(
        code='us-ca',
        name='US / Canada',
        countries=('US', 'CA'),
        currency='USD',
        whatsapp_cost_per_conversation=0.0250,
        arpu=2.50, enterprise_arpu=1.80,
        base_subscription_per_location=39.0,
        fx_to_usd=1.0,
        # Paystack international: 3.9%, no fixed fee.
        fee_pct=0.039, fee_fixed_per_charge=0.0,
        payg_open_price=0.10,           # $0.10/open → ~75% margin over Meta cost
        color=INK,
    ),
    Region(
        code='eu-west',
        name='Western Europe',
        countries=('GB', 'DE', 'FR', 'NL', 'ES', 'IT', 'IE', 'PT'),
        currency='EUR',
        whatsapp_cost_per_conversation=0.0200,
        arpu=2.20, enterprise_arpu=1.60,
        base_subscription_per_location=32.0,
        fx_to_usd=1.08,
        fee_pct=0.039, fee_fixed_per_charge=0.0,
        payg_open_price=0.08,
        color=SLATE,
    ),
    Region(
        code='za',
        name='South Africa',
        countries=('ZA',),
        currency='ZAR',
        whatsapp_cost_per_conversation=0.0080,   # Meta cost is in USD
        arpu=22.0, enterprise_arpu=15.0,
        base_subscription_per_location=349.0,
        fx_to_usd=0.054,
        # Paystack ZA local: 2.9% + R1.
        fee_pct=0.029, fee_fixed_per_charge=1.0,
        payg_open_price=1.50,            # R1.50/open ≈ $0.081 → ~90% margin
        color=TERRACOTTA,
    ),
    Region(
        code='latam',
        name='Brazil / LATAM',
        countries=('BR', 'MX', 'AR', 'CO', 'CL'),
        currency='USD',
        whatsapp_cost_per_conversation=0.0050,
        arpu=1.20, enterprise_arpu=0.80,
        base_subscription_per_location=15.0,
        fx_to_usd=1.0,
        fee_pct=0.039, fee_fixed_per_charge=0.0,
        payg_open_price=0.04,
        color=GOLD,
    ),
    Region(
        code='in-sea',
        name='India / SE Asia',
        countries=('IN', 'ID', 'PH', 'VN', 'MY', 'TH'),
        currency='USD',
        whatsapp_cost_per_conversation=0.0035,
        arpu=0.80, enterprise_arpu=0.55,           # raised from 0.6/0.4 — model was loss-making at 100 users
        base_subscription_per_location=12.0,        # raised from 9.0 to cover 1-location fixed cost share
        fx_to_usd=1.0,
        fee_pct=0.039, fee_fixed_per_charge=0.0,
        payg_open_price=0.03,
        color=MOSS,
    ),
)

DEFAULT_REGION = REGIONS[0]  # US/CA used as the baseline for the existing charts


def region_assumptions(a: Assumptions, r: Region) -> Assumptions:
    """Return an Assumptions copy with all USD-equivalent fields for the region.

    Charts/JSON are denominated in USD so currency-native Region values
    (arpu, base sub, fees) are converted via fx_to_usd. WhatsApp cost is
    already USD upstream and is NOT scaled by fx.
    """
    return replace(
        a,
        whatsapp_cost_per_conversation=r.whatsapp_cost_per_conversation,
        arpu=r.arpu * r.fx_to_usd,
        enterprise_arpu=r.enterprise_arpu * r.fx_to_usd,
        base_subscription_per_location=r.base_subscription_per_location * r.fx_to_usd,
        fee_pct=r.fee_pct,
        fee_fixed_per_charge=r.fee_fixed_per_charge * r.fx_to_usd,
    )


# ── Model ────────────────────────────────────────────────────────────────────


def model(users: int, a: Assumptions) -> dict:
    devices = max(1.0, users / a.users_per_device)
    locations = max(1.0, devices / a.devices_per_location)

    opens = users * a.opens_per_user_month
    # Web portal absorbs `portal_substitution` of opens with zero Meta cost.
    whatsapp_opens = opens * (1.0 - a.portal_substitution)
    portal_opens = opens * a.portal_substitution
    msgs = whatsapp_opens * a.msgs_per_conversation

    # Revenue: take the higher of per-user or per-location floor
    arpu = a.enterprise_arpu if users >= a.enterprise_user_threshold else a.arpu
    revenue_per_user = users * arpu
    revenue_floor = locations * a.base_subscription_per_location
    revenue = max(revenue_per_user, revenue_floor)

    # WhatsApp: subtract Meta's free conversation tier (per WABA, regional)
    billable_conversations = max(0.0, whatsapp_opens - a.free_conversations_per_business_month)
    whatsapp_cost = billable_conversations * a.whatsapp_cost_per_conversation

    # Other costs
    server_cost = msgs * a.server_cost_per_msg + portal_opens * a.server_cost_per_msg * 1.5
    db_cost = users * a.db_cost_per_user_month
    devices_cost = devices * (a.device_gsm_cost_per_month + a.device_other_cost_per_month)
    fixed = a.fixed_hosting + a.fixed_monitoring + a.fixed_misc

    # Paystack: % of revenue + fixed fee per renewal (one charge per location)
    paystack_cost = revenue * a.fee_pct + locations * a.fee_fixed_per_charge

    # Resend: fixed plan + overage above the included pool
    emails = users * a.emails_per_user_per_month
    resend_overage = max(0.0, emails - a.resend_included_per_month) * a.resend_per_email
    resend_cost = a.resend_fixed_monthly + resend_overage

    total_cost = whatsapp_cost + server_cost + db_cost + devices_cost + fixed + paystack_cost + resend_cost
    profit = revenue - total_cost
    margin = (profit / revenue * 100) if revenue > 0 else 0.0

    return {
        'users': users,
        'devices': round(devices, 1),
        'locations': round(locations, 1),
        'opens': opens,
        'whatsapp_opens': whatsapp_opens,
        'portal_opens': portal_opens,
        'billable_conversations': billable_conversations,
        'msgs': msgs,
        'arpu_used': arpu,
        'revenue': revenue,
        'whatsapp': whatsapp_cost,
        'server': server_cost,
        'db': db_cost,
        'devices_cost': devices_cost,
        'fixed': fixed,
        'paystack': paystack_cost,
        'resend': resend_cost,
        'emails': emails,
        'total_cost': total_cost,
        'profit': profit,
        'margin': margin,
    }


# ── Style ────────────────────────────────────────────────────────────────────


def setup_style():
    plt.rcParams.update({
        'figure.facecolor': PAPER,
        'axes.facecolor': PAPER,
        'axes.edgecolor': INK,
        'axes.labelcolor': INK,
        'axes.titlecolor': INK,
        'xtick.color': INK,
        'ytick.color': INK,
        'text.color': INK,
        'axes.grid': True,
        'grid.color': INK,
        'grid.alpha': 0.07,
        'grid.linewidth': 0.6,
        'axes.spines.top': False,
        'axes.spines.right': False,
        'axes.spines.left': False,
        'font.family': ['Georgia', 'serif'],
        'font.size': 11,
        'axes.titlesize': 16,
        'axes.titleweight': 'bold',
        'axes.titlepad': 18,
        'legend.frameon': False,
    })


def fmt_users(n: float) -> str:
    if n >= 1_000_000:
        return f'{n/1_000_000:.0f}M'
    if n >= 1_000:
        return f'{n/1000:.0f}k'
    return f'{int(n)}'


def fmt_dollars_compact(x, _pos=None):
    if abs(x) >= 1_000_000:
        return f'${x/1_000_000:.1f}M'
    if abs(x) >= 1_000:
        return f'${x/1_000:.0f}k'
    return f'${x:.0f}'


# ── Charts ───────────────────────────────────────────────────────────────────


def chart_revenue_vs_cost(rows, out: Path):
    users = [r['users'] for r in rows]
    revenue = [r['revenue'] for r in rows]
    cost = [r['total_cost'] for r in rows]
    profit = [max(r['profit'], 1) for r in rows]  # symlog hates zero

    fig, ax = plt.subplots(figsize=(12, 7))
    ax.plot(users, revenue, 'o-', label='Revenue', color=MOSS, linewidth=2.6, markersize=9, markeredgecolor=PAPER, markeredgewidth=2)
    ax.plot(users, cost, 's-', label='Cost', color=TERRACOTTA, linewidth=2.6, markersize=9, markeredgecolor=PAPER, markeredgewidth=2)
    ax.plot(users, profit, '^-', label='Profit', color=INK, linewidth=2.6, markersize=10, markeredgecolor=PAPER, markeredgewidth=2)

    ax.set_xscale('log')
    ax.set_yscale('log')
    ax.set_xlabel('Active residents', fontsize=12)
    ax.set_ylabel('USD / month', fontsize=12)
    ax.set_title('Revenue, cost and profit at scale', loc='left')
    ax.set_xticks(users)
    ax.set_xticklabels([fmt_users(u) for u in users])
    ax.yaxis.set_major_formatter(plt.FuncFormatter(fmt_dollars_compact))
    ax.legend(loc='upper left', fontsize=11)

    for r in rows:
        sign = '+' if r['margin'] >= 0 else ''
        ax.annotate(
            f'{sign}{r["margin"]:.0f}% margin',
            xy=(r['users'], max(r['profit'], 1)),
            xytext=(0, 14),
            textcoords='offset points',
            ha='center',
            fontsize=10,
            color=INK,
            alpha=0.75,
        )

    fig.text(0.06, 0.965, 'whatsacc · billing model', fontfamily='monospace', fontsize=9, color=INK, alpha=0.55)
    plt.tight_layout()
    plt.savefig(out / 'revenue-vs-cost.png', dpi=160, facecolor=PAPER)
    plt.close()


def chart_cost_breakdown(rows, out: Path):
    user_labels = [fmt_users(r['users']) for r in rows]
    categories = ['WhatsApp', 'Devices (GSM)', 'Hosting + DB', 'Paystack', 'Resend', 'Server', 'Fixed misc']
    colors = [TERRACOTTA, GOLD, INK, SLATE, '#A56F8E', CLAY, MOSS]

    data = np.array([
        [r['whatsapp'], r['devices_cost'], r['db'], r['paystack'], r['resend'], r['server'], r['fixed']]
        for r in rows
    ]).T

    fig, ax = plt.subplots(figsize=(12, 7))
    bottom = np.zeros(len(rows))
    for cat, vals, c in zip(categories, data, colors):
        ax.bar(user_labels, vals, bottom=bottom, label=cat, color=c, edgecolor=PAPER, linewidth=1.5, width=0.55)
        bottom += vals

    ax.set_xlabel('Active residents', fontsize=12)
    ax.set_ylabel('Monthly cost (USD)', fontsize=12)
    ax.set_title('Cost breakdown', loc='left')
    ax.legend(loc='upper left', fontsize=10, ncol=3)
    ax.yaxis.set_major_formatter(plt.FuncFormatter(fmt_dollars_compact))
    ax.set_yscale('log')

    for i, r in enumerate(rows):
        ax.text(i, r['total_cost'] * 1.10, fmt_dollars_compact(r['total_cost']),
                ha='center', fontsize=10.5, color=INK, fontweight='bold')

    fig.text(0.06, 0.965, 'whatsacc · billing model', fontfamily='monospace', fontsize=9, color=INK, alpha=0.55)
    plt.tight_layout()
    plt.savefig(out / 'cost-breakdown.png', dpi=160, facecolor=PAPER)
    plt.close()


def chart_margin(rows, out: Path):
    users = [r['users'] for r in rows]
    margins = [r['margin'] for r in rows]

    fig, ax = plt.subplots(figsize=(12, 6))
    colors = [MOSS if m > 0 else TERRACOTTA for m in margins]
    ax.bar([fmt_users(u) for u in users], margins, color=colors, width=0.55, edgecolor=PAPER, linewidth=2)

    ax.axhline(0, color=INK, linewidth=1, alpha=0.4)
    ax.set_xlabel('Active residents', fontsize=12)
    ax.set_ylabel('Gross margin (%)', fontsize=12)
    ax.set_title('Gross margin by scale', loc='left')

    for i, m in enumerate(margins):
        offset = 2 if m >= 0 else -4
        ax.text(i, m + offset, f'{m:.0f}%',
                ha='center', va='bottom' if m >= 0 else 'top',
                fontsize=12, color=INK, fontweight='bold')

    fig.text(0.06, 0.96, 'whatsacc · billing model', fontfamily='monospace', fontsize=9, color=INK, alpha=0.55)
    plt.tight_layout()
    plt.savefig(out / 'margin-curve.png', dpi=160, facecolor=PAPER)
    plt.close()


def chart_per_user(rows, out: Path):
    users = [r['users'] for r in rows]
    arpu = [r['revenue'] / r['users'] for r in rows]
    cpu = [r['total_cost'] / r['users'] for r in rows]
    ppu = [r['profit'] / r['users'] for r in rows]

    x = np.arange(len(users))
    w = 0.27

    fig, ax = plt.subplots(figsize=(12, 6.5))
    ax.bar(x - w, arpu, w, label='Revenue / user', color=MOSS, edgecolor=PAPER, linewidth=1.5)
    ax.bar(x, cpu, w, label='Cost / user', color=TERRACOTTA, edgecolor=PAPER, linewidth=1.5)
    ax.bar(x + w, ppu, w, label='Profit / user', color=INK, edgecolor=PAPER, linewidth=1.5)

    ax.axhline(0, color=INK, linewidth=0.8, alpha=0.4)
    ax.set_xticks(x)
    ax.set_xticklabels([fmt_users(u) for u in users])
    ax.set_xlabel('Active residents', fontsize=12)
    ax.set_ylabel('USD / user / month', fontsize=12)
    ax.set_title('Per-user economics', loc='left')
    ax.legend(loc='upper right', fontsize=10)
    ax.set_yscale('symlog', linthresh=1)
    ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda x, _: f'${x:,.2f}' if abs(x) < 100 else f'${x:,.0f}'))

    for i, (a_v, c_v, p_v) in enumerate(zip(arpu, cpu, ppu)):
        for off, val in [(-w, a_v), (0, c_v), (w, p_v)]:
            ax.text(i + off, val if val >= 0 else val * 1.15,
                    f'${val:.2f}' if abs(val) < 100 else f'${val:.0f}',
                    ha='center',
                    va='bottom' if val >= 0 else 'top',
                    fontsize=8.5,
                    color=INK,
                    alpha=0.85)

    fig.text(0.06, 0.96, 'whatsacc · billing model', fontfamily='monospace', fontsize=9, color=INK, alpha=0.55)
    plt.tight_layout()
    plt.savefig(out / 'per-user-economics.png', dpi=160, facecolor=PAPER)
    plt.close()


def chart_region_profit(user_counts, out: Path, a: Assumptions):
    """Profit curve per region across user scales — the headline region chart."""
    fig, ax = plt.subplots(figsize=(12, 7))
    for r in REGIONS:
        a_r = region_assumptions(a, r)
        rows = [model(u, a_r) for u in user_counts]
        profits = [row['profit'] for row in rows]
        ax.plot(user_counts, profits, 'o-', label=r.name, linewidth=2.4, markersize=8,
                markeredgecolor=PAPER, markeredgewidth=1.5, color=r.color)

    ax.axhline(0, color=INK, linewidth=0.8, alpha=0.5, linestyle='--')
    ax.set_xscale('log')
    ax.set_yscale('symlog', linthresh=100)
    ax.set_xticks(user_counts)
    ax.set_xticklabels([fmt_users(u) for u in user_counts])
    ax.set_xlabel('Active residents', fontsize=12)
    ax.set_ylabel('Profit (USD / month)', fontsize=12)
    ax.set_title('Profit by region', loc='left')
    ax.legend(loc='upper left', fontsize=10)
    ax.yaxis.set_major_formatter(plt.FuncFormatter(fmt_dollars_compact))
    fig.text(0.06, 0.965, 'whatsacc · billing model', fontfamily='monospace', fontsize=9, color=INK, alpha=0.55)
    plt.tight_layout()
    plt.savefig(out / 'region-profit.png', dpi=160, facecolor=PAPER)
    plt.close()


def chart_region_revenue(user_counts, out: Path, a: Assumptions):
    """Revenue curve per region across user scales."""
    fig, ax = plt.subplots(figsize=(12, 7))
    for r in REGIONS:
        a_r = region_assumptions(a, r)
        rows = [model(u, a_r) for u in user_counts]
        revs = [row['revenue'] for row in rows]
        ax.plot(user_counts, revs, 'o-', label=r.name, linewidth=2.4, markersize=8,
                markeredgecolor=PAPER, markeredgewidth=1.5, color=r.color)

    ax.set_xscale('log')
    ax.set_yscale('log')
    ax.set_xticks(user_counts)
    ax.set_xticklabels([fmt_users(u) for u in user_counts])
    ax.set_xlabel('Active residents', fontsize=12)
    ax.set_ylabel('Revenue (USD / month)', fontsize=12)
    ax.set_title('Revenue by region', loc='left')
    ax.legend(loc='upper left', fontsize=10)
    ax.yaxis.set_major_formatter(plt.FuncFormatter(fmt_dollars_compact))
    fig.text(0.06, 0.965, 'whatsacc · billing model', fontfamily='monospace', fontsize=9, color=INK, alpha=0.55)
    plt.tight_layout()
    plt.savefig(out / 'region-revenue.png', dpi=160, facecolor=PAPER)
    plt.close()


def chart_region_snapshot(target_users: int, out: Path, a: Assumptions):
    """Bar chart of revenue / cost / profit per region at a single user scale."""
    region_rows = [(r, model(target_users, region_assumptions(a, r))) for r in REGIONS]

    labels = [r.name for r, _ in region_rows]
    revenue = [row['revenue'] for _, row in region_rows]
    cost = [row['total_cost'] for _, row in region_rows]
    profit = [row['profit'] for _, row in region_rows]

    x = np.arange(len(labels))
    w = 0.27

    fig, ax = plt.subplots(figsize=(12, 6.5))
    ax.bar(x - w, revenue, w, label='Revenue', color=MOSS, edgecolor=PAPER, linewidth=1.5)
    ax.bar(x, cost, w, label='Cost', color=TERRACOTTA, edgecolor=PAPER, linewidth=1.5)
    ax.bar(x + w, profit, w, label='Profit', color=INK, edgecolor=PAPER, linewidth=1.5)

    ax.axhline(0, color=INK, linewidth=0.8, alpha=0.4)
    ax.set_xticks(x)
    ax.set_xticklabels(labels)
    ax.set_ylabel('USD / month', fontsize=12)
    ax.set_title(f'Region snapshot — {fmt_users(target_users)} active residents', loc='left')
    ax.legend(loc='upper right', fontsize=10)
    ax.yaxis.set_major_formatter(plt.FuncFormatter(fmt_dollars_compact))

    for i, (rev, cst, pr) in enumerate(zip(revenue, cost, profit)):
        for off, val in [(-w, rev), (0, cst), (w, pr)]:
            ax.text(i + off, val * (1.02 if val >= 0 else 1.05),
                    fmt_dollars_compact(val),
                    ha='center', va='bottom' if val >= 0 else 'top',
                    fontsize=9, color=INK, alpha=0.85)

    fig.text(0.06, 0.965, 'whatsacc · billing model', fontfamily='monospace', fontsize=9, color=INK, alpha=0.55)
    plt.tight_layout()
    plt.savefig(out / f'region-snapshot-{fmt_users(target_users)}.png', dpi=160, facecolor=PAPER)
    plt.close()


def chart_whatsapp_sensitivity(rows, out: Path, a: Assumptions):
    user_counts = [r['users'] for r in rows]
    scenarios = [
        ('$0.005 (ZA / IN service)', 0.005, GOLD),
        ('$0.006 (current blend)', 0.006, MOSS),
        ('$0.012 (mid-tier service)', 0.012, INK),
        ('$0.025 (US service)', 0.025, TERRACOTTA),
    ]

    fig, ax = plt.subplots(figsize=(12, 6.5))
    for label, price, color in scenarios:
        a_alt = replace(a, whatsapp_cost_per_conversation=price)
        profits = [model(u, a_alt)['profit'] for u in user_counts]
        ax.plot(user_counts, profits, 'o-', label=label,
                linewidth=2.4, markersize=8, markeredgecolor=PAPER, markeredgewidth=1.5,
                color=color)

    ax.set_xscale('log')
    ax.set_yscale('symlog', linthresh=100)
    ax.set_xticks(user_counts)
    ax.set_xticklabels([fmt_users(u) for u in user_counts])
    ax.set_xlabel('Active residents', fontsize=12)
    ax.set_ylabel('Profit (USD / month)', fontsize=12)
    ax.set_title('WhatsApp price sensitivity', loc='left')
    ax.legend(loc='upper left', fontsize=10)
    ax.axhline(0, color=INK, linewidth=0.8, alpha=0.5, linestyle='--')
    ax.yaxis.set_major_formatter(plt.FuncFormatter(fmt_dollars_compact))

    fig.text(0.06, 0.96, 'whatsacc · billing model', fontfamily='monospace', fontsize=9, color=INK, alpha=0.55)
    plt.tight_layout()
    plt.savefig(out / 'sensitivity.png', dpi=160, facecolor=PAPER)
    plt.close()


# ── Run ──────────────────────────────────────────────────────────────────────


# ── Tiers ────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class TierShape:
    """Tier shape, expressed as multipliers of the regional base subscription.

    For each tier we set a *price multiplier* over the region's base
    subscription, and quotas (residents, devices, locations, opens/mo). The
    `simulate` step then runs the model at the tier's expected operating point
    and verifies margin.
    """
    code: str
    name: str
    price_mult: float           # × region.base_subscription_per_location
    residents: int              # included
    devices: int                # included
    locations: int              # included
    opens_per_month: int        # WhatsApp+portal combined included
    blurb: str


TIERS: Tuple[TierShape, ...] = (
    TierShape('free',     'Free',       0.0,    5,   1,  1,    100,  'Try it. Includes web portal access.'),
    TierShape('starter',  'Starter',    1.0,    30,  3,  1,    900,  'For a single estate or building.'),
    TierShape('growth',   'Growth',     2.6,    100, 8,  2,    3000, 'Most popular — small estate.'),
    TierShape('business', 'Business',   6.5,    300, 20, 5,    9000, 'Multi-site or large estate.'),
    TierShape('scale',    'Scale',      18.0,   1000,60, 15,   30000,'Enterprise estates / property mgmt.'),
)


def _format_currency(amount: float, currency: str) -> str:
    if currency in ('USD', 'EUR'):
        return f'{currency} {amount:,.2f}'
    return f'{currency} {amount:,.0f}'


def _account_marginal_cost(a: Assumptions, users: int, opens: float) -> dict:
    """Marginal cost to serve a single customer account.

    Excludes platform-wide fixed overhead (hosting/monitoring/misc + Resend
    base plan) — those are amortised across all paying accounts and would
    distort per-tier margin if charged to every individual account.
    """
    # Devices/locations sized to actual residents, not the tier ceiling.
    devices = max(1.0, users / a.users_per_device)
    locations = max(1.0, devices / a.devices_per_location)

    whatsapp_opens = opens * (1.0 - a.portal_substitution)
    portal_opens = opens * a.portal_substitution
    msgs = whatsapp_opens * a.msgs_per_conversation

    whatsapp = whatsapp_opens * a.whatsapp_cost_per_conversation
    server = msgs * a.server_cost_per_msg + portal_opens * a.server_cost_per_msg * 1.5
    db = users * a.db_cost_per_user_month
    devices_cost = devices * (a.device_gsm_cost_per_month + a.device_other_cost_per_month)
    # Resend is metered on overage above 50k/mo platform-wide; per-account
    # marginal is essentially the per-email cost on this account's emails.
    resend = users * a.emails_per_user_per_month * a.resend_per_email
    return {
        'devices': devices,
        'locations': locations,
        'whatsapp_opens': whatsapp_opens,
        'portal_opens': portal_opens,
        'whatsapp': whatsapp,
        'server': server,
        'db': db,
        'devices_cost': devices_cost,
        'resend': resend,
        'subtotal': whatsapp + server + db + devices_cost + resend,
    }


def derive_tiers(a: Assumptions, r: Region) -> List[dict]:
    """For each tier, compute regional price + simulated unit economics.

    Returns one row per tier, denominated in the region's local currency
    (so the frontend can render directly), with USD-equivalents alongside.
    """
    a_r = region_assumptions(a, r)
    out = []
    for t in TIERS:
        # Price in local currency (rounded to a clean number per region).
        if t.code == 'free':
            local_price = 0.0
        else:
            raw = r.base_subscription_per_location * t.price_mult
            local_price = _round_price(raw, r.currency)

        # Operating point: tier filled to 90% residents, 80% of opens cap.
        users = max(int(t.residents * 0.9), 1)
        opens = t.opens_per_month * 0.8
        mc = _account_marginal_cost(a_r, users, opens)

        sim_revenue_usd = local_price * r.fx_to_usd
        paystack = sim_revenue_usd * a_r.fee_pct + mc['locations'] * a_r.fee_fixed_per_charge
        sim_total_cost = mc['subtotal'] + paystack
        sim_profit = sim_revenue_usd - sim_total_cost
        sim_margin = (sim_profit / sim_revenue_usd * 100) if sim_revenue_usd > 0 else 0.0

        out.append({
            'code': t.code,
            'name': t.name,
            'currency': r.currency,
            'price_local': local_price,
            'price_usd': sim_revenue_usd,
            'residents': t.residents,
            'devices': t.devices,
            'locations': t.locations,
            'opens_per_month': t.opens_per_month,
            'web_portal': True,
            'blurb': t.blurb,
            'payg_open_price_local': r.payg_open_price,
            'payg_open_price_usd': r.payg_open_price * r.fx_to_usd,
            'sim': {
                'expected_users': users,
                'expected_opens': opens,
                'whatsapp_cost_usd': mc['whatsapp'],
                'devices_cost_usd': mc['devices_cost'],
                'paystack_cost_usd': paystack,
                'cost_usd': sim_total_cost,
                'profit_usd': sim_profit,
                'margin_pct': sim_margin,
            },
        })
    return out


def _round_price(amount: float, currency: str) -> float:
    """Round prices to clean retail values per currency convention."""
    if currency == 'ZAR':
        # R49, R149, R349, R899, R2499 — clean retail tiers
        if amount < 100:   return round(amount / 5) * 5 - 1
        if amount < 1000:  return round(amount / 50) * 50 - 1
        return round(amount / 100) * 100 - 1
    if currency == 'USD' or currency == 'EUR':
        if amount < 10:   return round(amount * 2) / 2 - 0.01    # $4.99
        if amount < 100:  return round(amount) - 0.01             # $19, $49, $99
        return round(amount / 10) * 10 - 1                        # $129, $349
    return round(amount, 2)


def main():
    if HAVE_PLOT:
        setup_style()
    else:
        print('(matplotlib unavailable — skipping chart rendering, JSON only)')

    a = Assumptions()
    user_counts = [10, 100, 1_000, 10_000, 100_000]

    out_dir = Path(__file__).parent / 'out'
    out_dir.mkdir(exist_ok=True)

    # ── Default-region rows (US/CA) for the existing single-region charts ────
    a_default = region_assumptions(a, DEFAULT_REGION)
    rows = [model(u, a_default) for u in user_counts]

    # ── Print summary ────────────────────────────────────────────────────────
    print()
    print('── whatsacc billing model ──────────────────────────────────────────────────────')
    print()
    print('Universal assumptions:')
    longest = max(len(k) for k in asdict(a).keys())
    for k, v in asdict(a).items():
        print(f'  {k:<{longest}} = {v}')

    print()
    print('Regions:')
    for r in REGIONS:
        print(f'  · {r.name:<18} {r.currency}  whatsapp ${r.whatsapp_cost_per_conversation:.4f}/conv  '
              f'arpu {r.currency} {r.arpu:>5.2f}  base {r.currency} {r.base_subscription_per_location:>5.0f}  '
              f'payg {r.currency} {r.payg_open_price:>5.2f}/open')

    print()
    print('Per-region snapshot at each user scale (USD-equivalent):')
    print(f'  {"region":<18} {"users":>9} {"revenue":>11} {"cost":>11} {"profit":>11} {"margin":>8}')
    print('  ' + '─' * 76)
    for r in REGIONS:
        a_r = region_assumptions(a, r)
        for u in user_counts:
            row = model(u, a_r)
            print(
                f'  {r.name:<18} '
                f'{row["users"]:>9,} '
                f'${row["revenue"]:>9,.0f} '
                f'${row["total_cost"]:>9,.0f} '
                f'${row["profit"]:>9,.0f} '
                f'{row["margin"]:>7.1f}%'
            )
        print()

    # ── Tier table ───────────────────────────────────────────────────────────
    print('Per-region tier pricing & simulated margin:')
    print(f'  {"region":<14} {"tier":<10} {"price":>14} {"opens/mo":>9} {"residents":>10} {"sim margin":>11}')
    print('  ' + '─' * 76)
    region_tiers = {}
    for r in REGIONS:
        tiers = derive_tiers(a, r)
        region_tiers[r.code] = tiers
        for t in tiers:
            price = _format_currency(t['price_local'], t['currency'])
            margin = f'{t["sim"]["margin_pct"]:.0f}%' if t['code'] != 'free' else '   —'
            print(
                f'  {r.code:<14} {t["code"]:<10} {price:>14} '
                f'{t["opens_per_month"]:>9,} {t["residents"]:>10} {margin:>11}'
            )
        print()

    # ── Charts ───────────────────────────────────────────────────────────────
    if HAVE_PLOT:
        chart_revenue_vs_cost(rows, out_dir)
        chart_cost_breakdown(rows, out_dir)
        chart_margin(rows, out_dir)
        chart_per_user(rows, out_dir)
        chart_whatsapp_sensitivity(rows, out_dir, a_default)
        chart_region_profit(user_counts, out_dir, a)
        chart_region_revenue(user_counts, out_dir, a)
        chart_region_snapshot(1_000, out_dir, a)
        chart_region_snapshot(10_000, out_dir, a)

    # ── Raw data ─────────────────────────────────────────────────────────────
    raw = {
        'assumptions': asdict(a),
        'regions': [
            {
                **asdict(r),
                'rows': [model(u, region_assumptions(a, r)) for u in user_counts],
                'tiers': region_tiers[r.code],
            }
            for r in REGIONS
        ],
    }
    (out_dir / 'data.json').write_text(json.dumps(raw, indent=2))

    # Compact tiers-only file for the backend/frontend to consume directly.
    tiers_only = {
        'generated_from': 'billing-model/generate.py',
        'regions': {
            r.code: {
                'name': r.name,
                'currency': r.currency,
                'countries': list(r.countries),
                'fx_to_usd': r.fx_to_usd,
                'payg_open_price_local': r.payg_open_price,
                'tiers': region_tiers[r.code],
            }
            for r in REGIONS
        },
    }
    (out_dir / 'tiers.json').write_text(json.dumps(tiers_only, indent=2))

    chart_count = len(list(out_dir.glob("*.png")))
    print(f'✓ {chart_count} charts + data.json + tiers.json written to {out_dir}/')


if __name__ == '__main__':
    main()
