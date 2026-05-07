import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { PageHeader } from './AppLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { useFormatZar } from '@/lib/billing/currency';
import {
  ApiError,
  api,
  type KycProfile,
  type PayoutRow,
  type ReferralMe,
} from '@/lib/api';

const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

function nextPayoutDate(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

function formatPayoutDate(d: Date): string {
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

export default function Referrals() {
  const formatZar = useFormatZar();
  const cents = (n: number) => formatZar(n / 100);
  const [data, setData] = useState<ReferralMe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingSlug, setEditingSlug] = useState(false);
  const [editingKyc, setEditingKyc] = useState(false);
  const next = useMemo(() => nextPayoutDate(), []);

  const refresh = useCallback(async () => {
    try {
      const r = await api.referralMe();
      setData(r);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load referrals.');
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const shareUrl = useMemo(() => {
    if (!data?.slug) return null;
    return `${window.location.origin}/r/${data.slug}`;
  }, [data?.slug]);

  return (
    <>
      <PageHeader
        kicker="Referrals"
        title="Earn 10% — for life"
        description="Share your link. Anyone who signs up through it earns you 10% of every wallet top-up they make, forever. Payouts are automatic on the 1st of every month — straight to your bank."
      />

      {error && (
        <Card className="mb-6 border-terracotta/40">
          <p className="text-sm text-terracotta-deep">{error}</p>
        </Card>
      )}

      {!data ? (
        <Card>
          <p className="text-ink/55 text-sm">Loading…</p>
        </Card>
      ) : (
        <>
          {!data.kyc_status.complete && data.balance.available_cents > 0 && (
            <Card className="mb-6 border-gold/40 bg-gold/5">
              <p className="text-sm text-ink/85">
                <span className="font-medium">Add your payout details before {formatPayoutDate(next)}</span>{' '}
                so we can send your earnings on the next run. We need your bank account, ID, and cellphone.
              </p>
              <button
                onClick={() => setEditingKyc(true)}
                className="mt-2 text-sm underline underline-offset-4 decoration-terracotta hover:text-ink"
              >
                Add details now
              </button>
            </Card>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 mb-6">
            <Card tone="ink" className="lg:col-span-5">
              <p className="text-[11px] uppercase tracking-[0.22em] text-paper/55">
                Earned this period
              </p>
              <p className="font-display text-5xl mt-3">
                {cents(data.balance.available_cents)}
              </p>
              <div className="mt-6 grid grid-cols-3 gap-3 text-xs text-paper/60">
                <Stat label="lifetime" value={cents(data.balance.earned_cents)} dark />
                <Stat label="in flight" value={cents(data.balance.pending_cents)} dark />
                <Stat label="paid out" value={cents(data.balance.paid_out_cents)} dark />
              </div>

              <div className="mt-6 pt-5 border-t border-paper/15">
                <p className="text-[10px] uppercase tracking-[0.22em] text-paper/55">Next payout</p>
                <p className="font-display text-2xl mt-1">{formatPayoutDate(next)}</p>
                <p className="text-xs text-paper/60 mt-1">
                  {data.balance.available_cents >= data.min_payout_cents
                    ? data.kyc_status.complete
                      ? 'You’ll be paid automatically.'
                      : 'Add payout details to be included.'
                    : `Minimum ${cents(data.min_payout_cents)} to be included.`}
                </p>
              </div>
            </Card>

            <Card className="lg:col-span-7">
              <p className="text-[11px] uppercase tracking-[0.22em] text-ink/55">Your link</p>
              {data.slug ? (
                <>
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <code className="flex-1 min-w-0 px-4 py-3 rounded-xl bg-paper-cool border border-ink/10 font-mono text-sm break-all">
                      {shareUrl}
                    </code>
                    <button
                      type="button"
                      className="h-11 px-4 rounded-full border border-ink/15 hover:border-ink text-sm"
                      onClick={() => {
                        if (shareUrl) navigator.clipboard.writeText(shareUrl);
                      }}
                    >
                      Copy
                    </button>
                    <button
                      type="button"
                      className="h-11 px-4 rounded-full text-sm text-ink/65 hover:text-ink"
                      onClick={() => setEditingSlug(true)}
                    >
                      Edit slug
                    </button>
                  </div>
                  <p className="mt-2 text-xs text-ink/50">
                    Slug: <span className="font-mono">{data.slug}</span>. You can change it once
                    every 24 hours.
                  </p>
                </>
              ) : (
                <p className="mt-3 text-ink/55 text-sm">
                  No slug yet. Set one to start sharing.
                </p>
              )}

              <div className="mt-6 grid grid-cols-2 gap-3">
                <Stat label="referees total" value={data.counts.referees_total.toString()} />
                <Stat label="active 30d" value={data.counts.referees_active_30d.toString()} />
              </div>
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 mb-6">
            <Card className="lg:col-span-7 p-0 overflow-hidden">
              <div className="px-6 py-4 border-b border-ink/10 flex items-baseline justify-between">
                <h2 className="font-display text-2xl">Recent earnings</h2>
                <span className="text-[11px] uppercase tracking-[0.18em] text-ink/45">
                  10% of top-ups
                </span>
              </div>
              {data.recent_earnings.length === 0 ? (
                <div className="px-6 py-8 text-ink/55 text-sm">
                  No earnings yet. Share your link to start.
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      {['Referee', 'Source', 'Amount', 'When'].map((h) => (
                        <th
                          key={h}
                          className="text-left px-6 py-3 text-[11px] uppercase tracking-[0.18em] text-ink/55 font-normal"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent_earnings.map((e) => (
                      <tr key={e.id} className="border-t border-ink/8">
                        <td className="px-6 py-3 font-mono text-xs">{e.referee_email_masked}</td>
                        <td className="px-6 py-3 text-ink/65 capitalize">
                          {e.source_kind.replace(/_/g, ' ')}
                        </td>
                        <td className="px-6 py-3 font-display text-lg">
                          {cents(e.amount_zar_cents)}
                        </td>
                        <td className="px-6 py-3 text-ink/55 text-xs">
                          {new Date(e.created_at).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>

            <Card className="lg:col-span-5">
              <div className="flex items-baseline justify-between mb-3">
                <p className="text-[11px] uppercase tracking-[0.22em] text-ink/55">
                  Payout details (KYC)
                </p>
                <span
                  className={`text-[10px] uppercase tracking-[0.18em] px-2 py-0.5 rounded-full ${
                    data.kyc_status.complete
                      ? 'bg-moss/15 text-moss'
                      : 'bg-gold/20 text-ink/80'
                  }`}
                >
                  {data.kyc_status.complete ? 'complete' : 'incomplete'}
                </span>
              </div>
              <p className="text-sm text-ink/65 leading-relaxed">
                Before we can send a payout we need: full name, cellphone, ID number, and South
                African banking details. Stored encrypted at rest.
              </p>
              <Button
                variant={data.kyc_status.complete ? 'outline' : 'ink'}
                size="lg"
                className="mt-5 w-full"
                onClick={() => setEditingKyc(true)}
              >
                {data.kyc_status.complete ? 'Update details' : 'Add payout details'}
              </Button>
            </Card>
          </div>

          <Card className="p-0 overflow-hidden">
            <div className="px-6 py-4 border-b border-ink/10">
              <h2 className="font-display text-2xl">Payouts</h2>
            </div>
            {data.payouts.length === 0 ? (
              <div className="px-6 py-8 text-ink/55 text-sm">No payouts yet.</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    {['Period', 'Amount', 'Status', 'Settled'].map((h) => (
                      <th
                        key={h}
                        className="text-left px-6 py-3 text-[11px] uppercase tracking-[0.18em] text-ink/55 font-normal"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.payouts.map((p) => (
                    <PayoutRowEl key={p.id} row={p} />
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}

      {editingSlug && data && (
        <SlugEditor
          current={data.slug ?? ''}
          onClose={() => setEditingSlug(false)}
          onSaved={() => {
            setEditingSlug(false);
            refresh();
          }}
        />
      )}

      {editingKyc && (
        <KycEditor
          onClose={() => setEditingKyc(false)}
          onSaved={() => {
            setEditingKyc(false);
            refresh();
          }}
        />
      )}

    </>
  );
}

function Stat({ label, value, dark = false }: { label: string; value: string; dark?: boolean }) {
  return (
    <div>
      <p className={`font-display text-lg leading-none ${dark ? 'text-paper' : ''}`}>{value}</p>
      <p
        className={`text-[10px] uppercase tracking-[0.18em] mt-1 ${
          dark ? 'text-paper/55' : 'text-ink/50'
        }`}
      >
        {label}
      </p>
    </div>
  );
}

function PayoutRowEl({ row }: { row: PayoutRow }) {
  const formatZar = useFormatZar();
  const cents = (n: number) => formatZar(n / 100);
  const tone: Record<typeof row.status, string> = {
    pending: 'text-ink/55 bg-ink/5',
    approved: 'text-gold bg-gold/10',
    paid: 'text-moss bg-moss/15',
    rejected: 'text-terracotta-deep bg-terracotta/10',
    cancelled: 'text-ink/50 bg-ink/5',
  };
  const label: Record<typeof row.status, string> = {
    pending: 'queued',
    approved: 'sent to bank',
    paid: 'paid',
    rejected: 'failed',
    cancelled: 'cancelled',
  };
  return (
    <tr className="border-t border-ink/8">
      <td className="px-6 py-3 text-ink/65 text-xs">
        {new Date(row.requested_at).toLocaleString()}
      </td>
      <td className="px-6 py-3 font-display text-lg">{cents(row.amount_zar_cents)}</td>
      <td className="px-6 py-3">
        <span
          className={`inline-flex items-center gap-2 px-2.5 py-0.5 rounded-full text-xs ${tone[row.status]}`}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-current" />
          {label[row.status]}
        </span>
      </td>
      <td className="px-6 py-3 text-ink/55 text-xs">
        {row.processed_at ? new Date(row.processed_at).toLocaleString() : '—'}
      </td>
    </tr>
  );
}

function SlugEditor({
  current,
  onClose,
  onSaved,
}: {
  current: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [slug, setSlug] = useState(current);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    const v = slug.trim().toLowerCase();
    if (!SLUG_RE.test(v) || v.length < 3 || v.length > 30 || v.includes('--')) {
      setErrorMsg('3-30 lowercase letters, digits, hyphens. No leading/trailing hyphens.');
      return;
    }
    setSubmitting(true);
    try {
      await api.referralUpdateSlug(v);
      onSaved();
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.code === 'slug_taken'
            ? 'That slug is already taken.'
            : err.code === 'slug_change_cooldown'
              ? 'You can only change your slug once every 24 hours.'
              : (err.detail ?? err.code)
          : err instanceof Error
            ? err.message
            : 'Could not update slug.';
      setErrorMsg(msg);
      setSubmitting(false);
    }
  }

  return (
    <Modal open onClose={onClose}>
      <h2 className="font-display text-2xl mb-1">Change your slug</h2>
      <p className="text-sm text-ink/60 mb-5">Your link becomes /r/&lt;slug&gt;.</p>
      <form onSubmit={onSubmit} className="space-y-4">
        <label className="block">
          <span className="text-sm font-medium text-ink/85">Slug</span>
          <div className="mt-1.5 flex items-center gap-2">
            <span className="text-ink/45 text-sm">/r/</span>
            <input
              autoFocus
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              className="flex-1 h-11 rounded-xl bg-paper-cool border border-ink/15 px-4 font-mono focus:outline-none focus:ring-2 focus:ring-ink"
              placeholder="yusuf-adams"
            />
          </div>
        </label>
        {errorMsg && <p className="text-sm text-terracotta-deep">{errorMsg}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="h-10 px-4 rounded-full text-sm text-ink/65 hover:text-ink"
          >
            Cancel
          </button>
          <Button type="submit" variant="ink" disabled={submitting}>
            {submitting ? 'Saving…' : 'Save slug'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function KycEditor({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [k, setK] = useState<Partial<KycProfile> | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    api
      .kycGet()
      .then((r) => setK(r.kyc ?? {}))
      .catch(() => setK({}));
  }, []);

  function set<K extends keyof KycProfile>(key: K, v: KycProfile[K]) {
    setK((prev) => ({ ...(prev ?? {}), [key]: v }));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!k) return;
    setErrorMsg(null);
    setSubmitting(true);
    try {
      const payload: Partial<KycProfile> = {};
      const keys: (keyof KycProfile)[] = [
        'full_name',
        'contact_email',
        'cellphone',
        'id_kind',
        'id_number',
        'bank_name',
        'bank_branch_code',
        'bank_account_number',
        'bank_account_holder',
        'bank_account_type',
      ];
      for (const key of keys) {
        const v = k[key];
        if (v !== undefined && v !== null && v !== '') {
          (payload as Record<string, unknown>)[key] = v;
        }
      }
      await api.kycPut(payload);
      onSaved();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not save details.');
      setSubmitting(false);
    }
  }

  if (!k) return null;

  return (
    <Modal open onClose={onClose} className="sm:max-w-xl">
      <h2 className="font-display text-2xl mb-1">Payout details</h2>
      <p className="text-sm text-ink/60 mb-5">
        We need this to send your payouts. South African bank account required for ZAR transfers.
      </p>
      <form onSubmit={onSubmit} className="space-y-3">
        <Field
          label="Full name"
          value={k.full_name ?? ''}
          onChange={(v) => set('full_name', v)}
          autoComplete="name"
        />
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Contact email"
            type="email"
            value={k.contact_email ?? ''}
            onChange={(v) => set('contact_email', v)}
            autoComplete="email"
          />
          <Field
            label="Cellphone"
            type="tel"
            value={k.cellphone ?? ''}
            onChange={(v) => set('cellphone', v)}
            placeholder="+27 82 555 0144"
            autoComplete="tel"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-sm font-medium text-ink/85">ID kind</span>
            <select
              value={k.id_kind ?? ''}
              onChange={(e) => set('id_kind', (e.target.value || null) as KycProfile['id_kind'])}
              className="mt-1.5 w-full h-11 rounded-xl bg-paper-cool border border-ink/15 px-3 focus:outline-none focus:ring-2 focus:ring-ink"
            >
              <option value="">Select…</option>
              <option value="za_id">SA ID</option>
              <option value="passport">Passport</option>
            </select>
          </label>
          <Field
            label="ID number"
            value={k.id_number ?? ''}
            onChange={(v) => set('id_number', v)}
          />
        </div>

        <div className="pt-3 border-t border-ink/10" />

        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Bank name"
            value={k.bank_name ?? ''}
            onChange={(v) => set('bank_name', v)}
            placeholder="FNB / Standard Bank…"
          />
          <Field
            label="Branch code"
            value={k.bank_branch_code ?? ''}
            onChange={(v) => set('bank_branch_code', v)}
            placeholder="250655"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Account number"
            value={k.bank_account_number ?? ''}
            onChange={(v) => set('bank_account_number', v)}
          />
          <label className="block">
            <span className="text-sm font-medium text-ink/85">Account type</span>
            <select
              value={k.bank_account_type ?? ''}
              onChange={(e) =>
                set(
                  'bank_account_type',
                  (e.target.value || null) as KycProfile['bank_account_type'],
                )
              }
              className="mt-1.5 w-full h-11 rounded-xl bg-paper-cool border border-ink/15 px-3 focus:outline-none focus:ring-2 focus:ring-ink"
            >
              <option value="">Select…</option>
              <option value="cheque">Cheque</option>
              <option value="savings">Savings</option>
              <option value="transmission">Transmission</option>
            </select>
          </label>
        </div>
        <Field
          label="Account holder"
          value={k.bank_account_holder ?? ''}
          onChange={(v) => set('bank_account_holder', v)}
          placeholder="As it appears on the account"
        />

        {errorMsg && <p className="text-sm text-terracotta-deep">{errorMsg}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="h-10 px-4 rounded-full text-sm text-ink/65 hover:text-ink"
          >
            Cancel
          </button>
          <Button type="submit" variant="ink" disabled={submitting}>
            {submitting ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  autoComplete?: string;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-ink/85">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className="mt-1.5 w-full h-11 rounded-xl bg-paper-cool border border-ink/15 px-4 text-[15px] focus:outline-none focus:ring-2 focus:ring-ink"
      />
    </label>
  );
}
