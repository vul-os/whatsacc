import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from './AppLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { useAuth } from '@/lib/auth';
import { useFormatZar } from '@/lib/billing/currency';
import {
  ApiError,
  api,
  type AccountBilling,
  type BillingTier,
  type BillingTiersResponse,
  type InvoiceSummary,
  type WalletVerifyResponse,
} from '@/lib/api';

export default function Billing() {
  const { currentAccount } = useAuth();
  const accountId = currentAccount?.id ?? null;
  const formatZar = useFormatZar();

  const formatCents = (cents: number, currency: string) => {
    if (currency === 'ZAR') return formatZar(cents / 100);
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
    } catch {
      return `${currency} ${(cents / 100).toFixed(2)}`;
    }
  };

  const [billing, setBilling] = useState<AccountBilling | null>(null);
  const [invoices, setInvoices] = useState<InvoiceSummary[]>([]);
  const [tiersData, setTiersData] = useState<BillingTiersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<WalletVerifyResponse | null>(null);
  const [planModal, setPlanModal] = useState<BillingTier | null>(null);
  const [topUpModal, setTopUpModal] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  const refresh = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      const [data, invoiceData, td] = await Promise.all([
        api.accountBilling(accountId),
        api.invoices(accountId).catch(() => ({ invoices: [] })),
        api.tiers({ region: 'za' }).catch(() => null),
      ]);
      setBilling(data);
      setInvoices(invoiceData.invoices);
      setTiersData(td);
      setErrorMsg(null);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'account_billing_not_found') {
        setBilling({ subscription: null, wallet: null, payment_method: null, recent_intents: [] });
      } else {
        setErrorMsg(err instanceof Error ? err.message : 'Failed to load billing.');
      }
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => { refresh(); }, [refresh]);

  // After Paystack redirect: verify payment, then auto-activate plan if plan_code was passed.
  useEffect(() => {
    const reference = searchParams.get('reference') ?? searchParams.get('trxref');
    if (!reference) return;
    let cancelled = false;

    (async () => {
      try {
        const r = await api.walletVerify(reference);
        if (cancelled) return;
        setVerifyResult(r);
        setSearchParams({}, { replace: true });

        if (r.status === 'succeeded') {
          // Subscription checkout: server already activated the plan.
          if (r.plan_activated) {
            sessionStorage.removeItem('pending_plan_code');
            setSuccessMsg(`Payment received — ${r.plan_activated} plan activated.`);
          } else {
            // Plain top-up: check sessionStorage in case user had a pending plan.
            const pendingPlan = sessionStorage.getItem('pending_plan_code');
            if (pendingPlan && accountId) {
              sessionStorage.removeItem('pending_plan_code');
              try {
                await api.changePlan(accountId, pendingPlan);
                if (!cancelled) setSuccessMsg(`Payment received — ${pendingPlan} plan activated.`);
              } catch (err) {
                const detail = err instanceof ApiError ? (err.detail ?? err.code) : (err instanceof Error ? err.message : 'Could not activate plan.');
                if (!cancelled) setErrorMsg(`Payment received but plan activation failed: ${detail}`);
              }
            }
          }
        }
        refresh();
      } catch (e: unknown) {
        if (cancelled) return;
        setErrorMsg(e instanceof Error ? e.message : 'Verification failed.');
        setSearchParams({}, { replace: true });
      }
    })();

    return () => { cancelled = true; };
  }, [searchParams, setSearchParams, refresh, accountId]);

  if (!accountId) {
    return (
      <>
        <PageHeader kicker="Account" title="Billing" />
        <Card><p className="text-ink/65">No account selected.</p></Card>
      </>
    );
  }

  const walletBalance = billing?.wallet?.balance_cents ?? 0;
  const walletCurrency = billing?.wallet?.currency ?? 'ZAR';
  const currentPlanCode = billing?.subscription?.plan_code ?? 'free';
  const currentTier = tiersData?.tiers.find((t) => t.code === currentPlanCode) ?? null;

  async function downloadInvoice(invoice: Pick<InvoiceSummary, 'id' | 'number'>) {
    try {
      const blob = await api.invoicePdf(invoice.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${invoice.number}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not download invoice.');
    }
  }

  return (
    <>
      <PageHeader
        kicker="Account"
        title="Billing"
        description="Manage your plan, top up your wallet, and download invoices."
      />

      {/* ── Banners ──────────────────────────────────────────── */}
      {successMsg && (
        <div className="mb-6 rounded-xl px-5 py-4 flex items-start justify-between gap-4 bg-moss/8 border border-moss/25">
          <p className="text-sm font-medium text-moss">{successMsg}</p>
          <button onClick={() => setSuccessMsg(null)} className="text-ink/35 hover:text-ink text-lg leading-none flex-shrink-0">×</button>
        </div>
      )}

      {verifyResult && !successMsg && (
        <div className={`mb-6 rounded-xl px-5 py-4 flex items-start justify-between gap-4 ${
          verifyResult.status === 'succeeded'
            ? 'bg-moss/8 border border-moss/25'
            : 'bg-terracotta/8 border border-terracotta/25'
        }`}>
          <div>
            <p className={`text-sm font-medium ${verifyResult.status === 'succeeded' ? 'text-moss' : 'text-terracotta-deep'}`}>
              {verifyResult.status === 'succeeded' ? 'Payment confirmed' : "Payment didn't complete"}
            </p>
            <p className="text-xs text-ink/55 mt-0.5">
              {verifyResult.status === 'succeeded'
                ? verifyResult.already_credited
                  ? 'Already credited — no duplicate charge.'
                  : `Wallet credited with ${formatCents(verifyResult.amount_cents, verifyResult.currency)}.`
                : `Status: ${verifyResult.status}. Try again or use a different card.`}
            </p>
          </div>
          <button onClick={() => setVerifyResult(null)} className="text-ink/35 hover:text-ink text-lg leading-none flex-shrink-0">×</button>
        </div>
      )}

      {errorMsg && (
        <div className="mb-6 rounded-xl px-5 py-4 bg-terracotta/8 border border-terracotta/25">
          <p className="text-sm text-terracotta-deep">{errorMsg}</p>
        </div>
      )}

      {/* ── Hero row ─────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
        <Card tone="ink" className="flex flex-col gap-2">
          <div className="flex items-start justify-between">
            <p className="text-[11px] uppercase tracking-[0.22em] text-paper/50">Current plan</p>
            <SubscriptionStatusBadge status={billing?.subscription?.status ?? null} />
          </div>
          <p className="font-display text-4xl mt-1">{currentTier?.name ?? currentPlanCode}</p>
          <p className="text-paper/55 text-sm">{currentTier?.blurb ?? 'Free tier'}</p>
          {billing?.subscription?.current_period_end && (
            <p className="text-xs text-paper/35 mt-auto pt-4">
              Renews {new Date(billing.subscription.current_period_end).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' })}
            </p>
          )}
        </Card>

        <Card className="flex flex-col gap-2">
          <div className="flex items-start justify-between">
            <p className="text-[11px] uppercase tracking-[0.22em] text-ink/50">Wallet balance</p>
            <span className="text-[10px] uppercase tracking-widest text-ink/40 border border-ink/10 rounded-full px-2 py-0.5">Prepaid</span>
          </div>
          <p className="font-display text-4xl mt-1">
            {loading && !billing ? '—' : formatCents(walletBalance, walletCurrency)}
          </p>
          <p className="text-ink/50 text-sm">Usage credits · WhatsApp, Slack &amp; gate opens</p>
          {billing?.payment_method?.card_last4 && (
            <p className="text-xs text-ink/40 flex items-center gap-1.5 mt-1">
              <CardIcon size={14} />
              {billing.payment_method.card_brand ? capitalize(billing.payment_method.card_brand) : 'Card'} ···· {billing.payment_method.card_last4}
            </p>
          )}
          <Button variant="ink" size="sm" className="mt-auto self-start" onClick={() => setTopUpModal(true)}>
            Top up wallet
          </Button>
        </Card>
      </div>

      {/* ── Plans ────────────────────────────────────────────── */}
      {tiersData && (
        <section className="mb-8">
          <div className="flex items-baseline justify-between mb-4">
            <div>
              <h2 className="font-display text-2xl">Plans</h2>
              <p className="text-sm text-ink/50 mt-0.5">Subscription is charged directly to your card. Wallet credits cover WhatsApp, Slack &amp; usage above your plan limit.</p>
            </div>
            {tiersData.payg_open_price > 0 && (
              <p className="text-xs text-ink/45 hidden sm:block">
                PAYG above cap: <span className="font-medium text-ink/65">{tiersData.currency} {tiersData.payg_open_price.toFixed(2)}/open</span>
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {tiersData.tiers.map((tier) => (
              <PlanCard
                key={tier.code}
                tier={tier}
                currency={tiersData.currency}
                isCurrent={tier.code === currentPlanCode}
                hasCard={billing?.payment_method?.has_authorization ?? false}
                onSelect={() => setPlanModal(tier)}
              />
            ))}
          </div>
        </section>
      )}

      {/* ── Recent payments ──────────────────────────────────── */}
      <section className="mb-8">
        <h2 className="font-display text-2xl mb-4">Recent payments</h2>
        <Card className="p-0 overflow-hidden">
          {loading && !billing ? (
            <p className="px-6 py-8 text-ink/50 text-sm">Loading…</p>
          ) : !billing?.recent_intents.length ? (
            <p className="px-6 py-8 text-ink/50 text-sm">No payments yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink/8">
                  {['Reference', 'Amount', 'Status', 'Date', ''].map((h) => (
                    <th key={h} className="text-left px-6 py-3 text-[11px] uppercase tracking-[0.18em] text-ink/40 font-normal">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {billing.recent_intents.map((it) => (
                  <tr key={it.id} className="border-b border-ink/5 last:border-0 hover:bg-ink/[0.02]">
                    <td className="px-6 py-4 font-mono text-xs text-ink/55">{it.provider_reference}</td>
                    <td className="px-6 py-4 font-display text-base">{formatCents(it.amount_cents, it.currency)}</td>
                    <td className="px-6 py-4"><TxStatusPill status={it.status} /></td>
                    <td className="px-6 py-4 text-xs text-ink/50">
                      {new Date(it.created_at).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </td>
                    <td className="px-6 py-4 text-right">
                      {it.invoice_id && (
                        <button
                          onClick={() => downloadInvoice({ id: it.invoice_id!, number: it.provider_reference })}
                          className="text-xs text-ink/45 hover:text-ink underline underline-offset-4 decoration-terracotta"
                        >
                          Invoice
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </section>

      {/* ── Invoices ─────────────────────────────────────────── */}
      {invoices.length > 0 && (
        <section>
          <h2 className="font-display text-2xl mb-4">Invoices</h2>
          <Card className="p-0 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink/8">
                  {['Invoice #', 'Amount', 'VAT', 'Status', 'Issued', ''].map((h) => (
                    <th key={h} className="text-left px-6 py-3 text-[11px] uppercase tracking-[0.18em] text-ink/40 font-normal">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id} className="border-b border-ink/5 last:border-0 hover:bg-ink/[0.02]">
                    <td className="px-6 py-4 font-mono text-xs text-ink/55">{inv.number}</td>
                    <td className="px-6 py-4 font-display text-base">{formatCents(inv.total_cents, inv.currency)}</td>
                    <td className="px-6 py-4 text-xs text-ink/50">
                      {inv.vat_cents > 0 ? `${formatCents(inv.vat_cents, inv.currency)} · ${(inv.vat_rate_bps / 100).toFixed(0)}%` : '—'}
                    </td>
                    <td className="px-6 py-4"><InvoiceStatusPill status={inv.status} /></td>
                    <td className="px-6 py-4 text-xs text-ink/50">
                      {new Date(inv.issued_at).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <button onClick={() => downloadInvoice(inv)} className="text-xs text-ink/45 hover:text-ink underline underline-offset-4 decoration-terracotta">
                        PDF
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </section>
      )}

      {/* ── Modals ───────────────────────────────────────────── */}
      {topUpModal && (
        <TopUpModal
          accountId={accountId}
          onClose={() => setTopUpModal(false)}
          onError={setErrorMsg}
        />
      )}

      {planModal && accountId && (
        <PlanSelectModal
          tier={planModal}
          currency={tiersData?.currency ?? 'ZAR'}
          hasCard={billing?.payment_method?.has_authorization ?? false}
          cardBrand={billing?.payment_method?.card_brand ?? null}
          cardLast4={billing?.payment_method?.card_last4 ?? null}
          accountId={accountId}
          formatCents={formatCents}
          onClose={() => setPlanModal(null)}
          onSwitched={() => { setPlanModal(null); refresh(); }}
        />
      )}
    </>
  );

}

function humanizePlanError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'already_on_plan': return "You're already on this plan.";
      case 'card_required':   return 'No card on file — choose "Pay & activate" to add one first.';
      case 'card_declined':   return 'Card was declined. Try a different card from Top up wallet.';
      case 'card_charge_failed':
        return err.detail
          ? `Card couldn't be charged: ${err.detail}`
          : "Card couldn't be charged. Try again or use a different card.";
      case 'payment_init_failed':
        return err.detail
          ? `Payment provider rejected the request: ${err.detail}`
          : 'Payment provider rejected the request. Check your email address and try again.';
      case 'plan_not_found':       return 'That plan is not available in your region.';
      case 'subscription_not_found': return 'No active subscription on this account. Contact support.';
      case 'not_account_admin':    return 'You need to be an account owner or admin to change the plan.';
      case 'internal_error':       return 'Server hiccup. Please try again — if it keeps failing, contact support.';
      default:                     return err.detail ?? err.code ?? fallback;
    }
  }
  if (err instanceof Error) return err.message;
  return fallback;
}

// ── Plan card ──────────────────────────────────────────────────────────────

function PlanCard({
  tier, currency, isCurrent, hasCard, onSelect,
}: {
  tier: BillingTier;
  currency: string;
  isCurrent: boolean;
  hasCard: boolean;
  onSelect: () => void;
}) {
  const label =
    tier.price === 0 ? 'Switch to Free' : hasCard ? 'Activate' : 'Add card & activate';

  return (
    <div className={`relative flex flex-col rounded-2xl border p-4 transition-colors ${
      isCurrent
        ? 'border-moss bg-moss/5 ring-1 ring-moss/20'
        : 'border-ink/10 bg-paper hover:border-ink/25 hover:shadow-sm'
    }`}>
      {isCurrent && (
        <span className="absolute -top-2.5 left-4 rounded-full bg-moss px-2.5 py-0.5 text-[10px] uppercase tracking-widest text-paper font-medium">
          Current
        </span>
      )}
      <p className="font-display text-base leading-tight">{tier.name}</p>
      <p className="mt-1 font-display text-2xl font-bold">
        {tier.price === 0 ? 'Free' : (
          <>
            <span className="text-sm font-normal text-ink/45 align-top mt-1 mr-0.5">{currency[0]}</span>
            {tier.price % 1 === 0 ? tier.price.toFixed(0) : tier.price.toFixed(2)}
            <span className="text-xs font-normal text-ink/40">/mo</span>
          </>
        )}
      </p>
      <p className="mt-2 text-[11px] text-ink/50 leading-snug flex-1">{tier.blurb}</p>
      <ul className="mt-3 space-y-0.5 text-[11px] text-ink/55">
        <li>{tier.included_opens.toLocaleString()} opens/mo</li>
        <li>{tier.included_residents} residents</li>
        <li>{tier.included_devices} device{tier.included_devices !== 1 ? 's' : ''}</li>
        <li>{tier.included_locations} location{tier.included_locations !== 1 ? 's' : ''}</li>
      </ul>
      {!isCurrent && (
        <button
          onClick={onSelect}
          className="mt-4 h-8 w-full rounded-xl border border-ink bg-ink text-paper text-xs font-medium hover:bg-ink/85 transition-colors"
        >
          {label}
        </button>
      )}
    </div>
  );
}

// ── Plan select modal ──────────────────────────────────────────────────────

function PlanSelectModal({
  tier, currency, hasCard, cardBrand, cardLast4, accountId, formatCents, onClose, onSwitched,
}: {
  tier: BillingTier;
  currency: string;
  hasCard: boolean;
  cardBrand: string | null;
  cardLast4: string | null;
  accountId: string;
  formatCents: (cents: number, currency: string) => string;
  onClose: () => void;
  onSwitched: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const priceCents = Math.round(tier.price * 100);

  async function activateWithCard() {
    setErrorMsg(null);
    setSubmitting(true);
    try {
      await api.changePlan(accountId, tier.code);
      onSwitched();
    } catch (err) {
      setErrorMsg(humanizePlanError(err, 'Could not switch plan.'));
      setSubmitting(false);
    }
  }

  async function checkoutToAddCard() {
    setErrorMsg(null);
    setSubmitting(true);
    try {
      const res = await api.subscriptionCheckout(accountId, tier.code);
      sessionStorage.setItem('pending_plan_code', tier.code);
      window.location.href = res.authorization_url;
    } catch (err) {
      setErrorMsg(humanizePlanError(err, 'Could not start payment.'));
      setSubmitting(false);
    }
  }

  return (
    <Modal open onClose={onClose} className="sm:max-w-md">
      <h2 className="font-display text-2xl mb-1">
        {tier.price === 0 ? 'Switch to Free' : `Activate ${tier.name}`}
      </h2>
      <p className="text-sm text-ink/55 mb-6">
        {tier.price === 0
          ? 'Downgrade to the free tier immediately — no charge.'
          : `${currency} ${tier.price}/month · charged to your card each renewal.`}
      </p>

      {/* Features */}
      <div className="rounded-xl bg-paper-cool border border-ink/8 p-4 mb-5">
        <p className="text-[11px] uppercase tracking-[0.18em] text-ink/40 mb-3">Included</p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          {[
            [`${tier.included_opens.toLocaleString()}/mo`, 'Opens'],
            [`${tier.included_residents}`, 'Residents'],
            [`${tier.included_devices}`, 'Devices'],
            [`${tier.included_locations}`, 'Locations'],
          ].map(([val, label]) => (
            <div key={label}>
              <p className="font-medium">{val}</p>
              <p className="text-xs text-ink/40">{label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Payment info */}
      {priceCents > 0 && (
        <div className={`rounded-xl px-4 py-3 mb-5 ${
          hasCard ? 'bg-moss/8 border border-moss/20' : 'bg-paper-cool border border-ink/10'
        }`}>
          {hasCard ? (
            <>
              <p className="text-sm font-medium flex items-center gap-2">
                <CardIcon size={14} />
                {cardBrand ? capitalize(cardBrand) : 'Card'}{cardLast4 ? ` ···· ${cardLast4}` : ''}
              </p>
              <p className="text-xs text-ink/55 mt-1">
                {formatCents(priceCents, currency)} charged now, then monthly on renewal.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-medium">No card saved yet</p>
              <p className="text-xs text-ink/55 mt-1 leading-relaxed">
                You'll be taken to Paystack to pay {formatCents(priceCents, currency)} and save your card. Your plan activates automatically after payment.
              </p>
            </>
          )}
        </div>
      )}

      {errorMsg && <p className="text-sm text-terracotta-deep mb-4">{errorMsg}</p>}

      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={onClose} className="h-10 px-4 rounded-full text-sm text-ink/50 hover:text-ink">
          Cancel
        </button>
        {tier.price === 0 ? (
          <Button variant="ink" disabled={submitting} onClick={activateWithCard}>
            {submitting ? 'Switching…' : 'Switch to Free'}
          </Button>
        ) : hasCard ? (
          <Button variant="ink" disabled={submitting} onClick={activateWithCard}>
            {submitting ? 'Charging card…' : `Activate ${tier.name}`}
          </Button>
        ) : (
          <Button variant="ink" disabled={submitting} onClick={checkoutToAddCard}>
            {submitting ? 'Redirecting…' : `Pay ${formatCents(priceCents, currency)} & activate`}
          </Button>
        )}
      </div>
    </Modal>
  );
}

// ── Top-up modal ───────────────────────────────────────────────────────────

function TopUpModal({
  accountId, onClose, onError,
}: {
  accountId: string;
  onClose: () => void;
  onError: (msg: string | null) => void;
}) {
  const [amount, setAmount] = useState('100');
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    onError(null);
    const rand = Number(amount);
    if (!Number.isFinite(rand) || rand < 10) {
      onError('Minimum top-up is R 10.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.walletTopup({
        account_id: accountId,
        amount_cents: Math.round(rand * 100),
        callback_path: '/app/billing',
      });
      window.location.href = res.authorization_url;
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to start payment.');
      setSubmitting(false);
    }
  }

  return (
    <Modal open onClose={onClose} className="sm:max-w-sm">
      <h2 className="font-display text-2xl mb-1">Top up wallet</h2>
      <p className="text-sm text-ink/55 mb-6">
        Pay via Paystack. Your card will be saved for future subscription renewals.
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <label className="block">
          <span className="text-sm font-medium text-ink/85">Amount (ZAR)</span>
          <div className="mt-1.5 flex items-center gap-2">
            <span className="text-ink/40 text-sm font-medium">R</span>
            <input
              type="number"
              inputMode="decimal"
              min="10"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="flex-1 h-11 rounded-xl bg-paper-cool border border-ink/15 px-4 text-[15px] focus:outline-none focus:ring-2 focus:ring-ink"
            />
          </div>
        </label>
        <div className="flex flex-wrap gap-2">
          {[100, 250, 500, 1000].map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setAmount(String(v))}
              className={`h-9 px-4 rounded-full border text-sm transition-colors ${
                amount === String(v)
                  ? 'border-ink bg-ink text-paper'
                  : 'border-ink/15 hover:border-ink/40'
              }`}
            >
              R {v}
            </button>
          ))}
        </div>
        <div className="flex items-center justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="h-10 px-4 rounded-full text-sm text-ink/50 hover:text-ink">Cancel</button>
          <Button type="submit" variant="ink" disabled={submitting}>
            {submitting ? 'Redirecting…' : 'Continue to Paystack'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Pill & misc components ─────────────────────────────────────────────────

function SubscriptionStatusBadge({ status }: { status: string | null }) {
  if (!status) return null;
  const cfg: Record<string, string> = {
    active:    'bg-moss/15 text-moss',
    trialing:  'bg-gold/20 text-ink/70',
    past_due:  'bg-terracotta/15 text-terracotta-deep',
    expired:   'bg-ink/8 text-ink/45',
    cancelled: 'bg-ink/8 text-ink/45',
  };
  return (
    <span className={`text-[10px] uppercase tracking-widest px-2.5 py-1 rounded-full ${cfg[status] ?? 'bg-ink/8 text-ink/45'}`}>
      {status.replace('_', ' ')}
    </span>
  );
}

function TxStatusPill({ status }: { status: string }) {
  const cfg: Record<string, string> = {
    pending:   'bg-ink/6 text-ink/45',
    succeeded: 'bg-moss/12 text-moss',
    failed:    'bg-terracotta/12 text-terracotta-deep',
    abandoned: 'bg-ink/6 text-ink/45',
  };
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs ${cfg[status] ?? 'bg-ink/6 text-ink/45'}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {status}
    </span>
  );
}

function InvoiceStatusPill({ status }: { status: string }) {
  const cfg: Record<string, string> = {
    paid:   'bg-moss/12 text-moss',
    issued: 'bg-ink/6 text-ink/45',
    void:   'bg-terracotta/12 text-terracotta-deep',
  };
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs ${cfg[status] ?? 'bg-ink/6 text-ink/45'}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {status}
    </span>
  );
}

function CardIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={Math.round(size * 0.75)} viewBox="0 0 24 18" fill="none" className="text-ink/40 inline-block">
      <rect x="0.5" y="0.5" width="23" height="17" rx="2.5" stroke="currentColor" />
      <rect x="0" y="4" width="24" height="3.5" fill="currentColor" opacity="0.25" />
      <rect x="3" y="11" width="5" height="1.5" rx="0.75" fill="currentColor" opacity="0.4" />
    </svg>
  );
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
