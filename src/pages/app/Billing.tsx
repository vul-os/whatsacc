import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PageHeader } from './AppLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/lib/auth';
import { ApiError, api, type AccountBilling, type WalletVerifyResponse } from '@/lib/api';

const ZAR = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' });

function formatCents(cents: number, currency: string): string {
  const amount = cents / 100;
  if (currency === 'ZAR') return ZAR.format(amount);
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

export default function Billing() {
  const { currentAccount } = useAuth();
  const accountId = currentAccount?.id ?? null;
  const [billing, setBilling] = useState<AccountBilling | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<WalletVerifyResponse | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const _navigate = useNavigate();

  const refresh = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      const data = await api.accountBilling(accountId);
      setBilling(data);
      setErrorMsg(null);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'account_billing_not_found') {
        setBilling({ subscription: null, wallet: null, recent_intents: [] });
        setErrorMsg(null);
      } else {
        setErrorMsg(err instanceof Error ? err.message : 'Failed to load billing.');
      }
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // After Paystack redirects back, ?reference=… is in the URL — verify, then strip.
  useEffect(() => {
    const reference = searchParams.get('reference') ?? searchParams.get('trxref');
    if (!reference) return;
    let cancelled = false;
    api
      .walletVerify(reference)
      .then((r) => {
        if (cancelled) return;
        setVerifyResult(r);
        setSearchParams({}, { replace: true });
        refresh();
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setErrorMsg(e instanceof Error ? e.message : 'Verification failed.');
        setSearchParams({}, { replace: true });
      });
    return () => {
      cancelled = true;
    };
  }, [searchParams, setSearchParams, refresh]);

  if (!accountId) {
    return (
      <>
        <PageHeader kicker="Account" title="Billing" />
        <Card>
          <p className="text-ink/65">No account selected yet. Create one to set up billing.</p>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        kicker="Account"
        title="Billing"
        description="Wallet-style balance — top up in ZAR via Paystack, spend per WhatsApp message."
      />

      {verifyResult && (
        <Card
          tone={verifyResult.status === 'succeeded' ? undefined : 'ink'}
          className={verifyResult.status === 'succeeded' ? 'mb-6 border-moss/60' : 'mb-6'}
        >
          {verifyResult.status === 'succeeded' ? (
            <p className="text-sm">
              <span className="font-medium text-moss">Payment received.</span>{' '}
              {verifyResult.already_credited
                ? 'Wallet was already credited for this transaction.'
                : `Wallet credited with ${formatCents(verifyResult.amount_cents, verifyResult.currency)}.`}
            </p>
          ) : (
            <p className="text-sm">
              Payment didn’t complete (status: {verifyResult.status}). Try again or use a
              different card.
            </p>
          )}
          <button
            className="mt-2 text-xs text-ink/55 hover:text-ink underline underline-offset-4"
            onClick={() => setVerifyResult(null)}
          >
            Dismiss
          </button>
        </Card>
      )}

      {errorMsg && (
        <Card className="mb-6 border-terracotta/40">
          <p className="text-sm text-terracotta-deep">{errorMsg}</p>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 mb-6">
        <Card tone="ink" className="lg:col-span-5">
          <p className="text-[11px] uppercase tracking-[0.22em] text-paper/55">Wallet balance</p>
          <p className="font-display text-5xl mt-3">
            {billing?.wallet
              ? formatCents(billing.wallet.balance_cents, billing.wallet.currency)
              : loading
                ? '—'
                : 'R 0.00'}
          </p>
          <p className="text-paper/60 mt-1">prepaid · spent per message</p>
          {billing?.subscription && (
            <p className="text-xs text-paper/55 mt-6 uppercase tracking-[0.18em]">
              Plan: {billing.subscription.plan_code}
            </p>
          )}
        </Card>

        <Card className="lg:col-span-7">
          <TopUpForm accountId={accountId} onError={setErrorMsg} />
        </Card>
      </div>

      <Card className="p-0 overflow-hidden">
        <div className="px-6 py-4 border-b border-ink/10">
          <h2 className="font-display text-2xl">Recent payments</h2>
        </div>
        {loading && !billing ? (
          <div className="px-6 py-8 text-ink/55 text-sm">Loading…</div>
        ) : !billing || billing.recent_intents.length === 0 ? (
          <div className="px-6 py-8 text-ink/55 text-sm">No payments yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr>
                {['Reference', 'Amount', 'Status', 'Initiated'].map((c) => (
                  <th
                    key={c}
                    className="text-left px-6 py-3 text-[11px] uppercase tracking-[0.18em] text-ink/55 font-normal"
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {billing.recent_intents.map((it) => (
                <tr key={it.id} className="border-t border-ink/8">
                  <td className="px-6 py-4 font-mono text-xs">{it.provider_reference}</td>
                  <td className="px-6 py-4 font-display text-lg">
                    {formatCents(it.amount_cents, it.currency)}
                  </td>
                  <td className="px-6 py-4">
                    <StatusPill status={it.status} />
                  </td>
                  <td className="px-6 py-4 text-ink/65">
                    {new Date(it.created_at).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

function TopUpForm({
  accountId,
  onError,
}: {
  accountId: string;
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
      const msg =
        err instanceof ApiError
          ? err.code === 'paystack_not_configured'
            ? 'Payments aren’t configured yet (PAYSTACK_SECRET_KEY missing).'
            : err.detail ?? err.code
          : err instanceof Error
            ? err.message
            : 'Failed to start payment.';
      onError(msg);
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit}>
      <p className="text-[11px] uppercase tracking-[0.22em] text-ink/55">Top up wallet</p>
      <p className="mt-2 text-sm text-ink/65">Pay in ZAR via Paystack hosted checkout.</p>

      <label className="block mt-5">
        <span className="text-sm font-medium text-ink/85">Amount (ZAR)</span>
        <div className="mt-1.5 flex items-center gap-3">
          <span className="text-ink/55 text-lg">R</span>
          <input
            type="number"
            inputMode="decimal"
            min="10"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="flex-1 h-12 rounded-xl bg-paper-cool border border-ink/15 px-4 text-[15px] focus:outline-none focus:ring-2 focus:ring-ink"
          />
        </div>
      </label>

      <div className="mt-3 flex flex-wrap gap-2">
        {[100, 250, 500, 1000].map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setAmount(String(v))}
            className="h-9 px-4 rounded-full border border-ink/15 hover:border-ink text-sm"
          >
            R {v}
          </button>
        ))}
      </div>

      <Button type="submit" variant="ink" size="lg" className="mt-6 w-full" disabled={submitting}>
        {submitting ? 'Redirecting to Paystack…' : 'Continue to Paystack'}
      </Button>
    </form>
  );
}

function StatusPill({
  status,
}: {
  status: 'pending' | 'succeeded' | 'failed' | 'abandoned';
}) {
  const cfg: Record<typeof status, { label: string; tone: string }> = {
    pending: { label: 'pending', tone: 'text-ink/55 bg-ink/5' },
    succeeded: { label: 'succeeded', tone: 'text-moss bg-moss/10' },
    failed: { label: 'failed', tone: 'text-terracotta-deep bg-terracotta/10' },
    abandoned: { label: 'abandoned', tone: 'text-ink/55 bg-ink/5' },
  };
  const c = cfg[status];
  return (
    <span className={`inline-flex items-center gap-2 px-2.5 py-0.5 rounded-full text-xs ${c.tone}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {c.label}
    </span>
  );
}
