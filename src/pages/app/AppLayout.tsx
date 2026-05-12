import { useState, type FormEvent } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { AppSidebar } from '@/components/nav/AppSidebar';
import { AppTopBar } from '@/components/nav/AppTopBar';
import { useAuth } from '@/lib/auth';
import { ApiError, api } from '@/lib/api';

export default function AppLayout() {
  const { signedIn, loading, user } = useAuth();
  if (loading) {
    return (
      <div className="min-h-screen bg-paper grid place-items-center text-ink/50 text-sm">
        Loading…
      </div>
    );
  }
  if (!signedIn) return <Navigate to="/login" replace />;

  return (
    <div className="min-h-screen bg-paper flex">
      <AppSidebar />
      <div className="flex-1 min-w-0 flex flex-col">
        <AppTopBar />
        <main className="flex-1 px-4 sm:px-6 lg:px-10 py-6 sm:py-10 max-w-[1400px] w-full mx-auto">
          {user && !user.has_verified_phone && <WhatsAppNumberBanner />}
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function WhatsAppNumberBanner() {
  const { refreshMe } = useAuth();
  const [phone, setPhone] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmed = phone.replace(/\s+/g, '');
    if (!/^\+[1-9]\d{6,14}$/.test(trimmed)) {
      setError('Use E.164 format, for example +27821234567.');
      return;
    }
    setSaving(true);
    try {
      await api.phoneAdd({ phone_e164: trimmed, is_primary: true });
      await refreshMe();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? (err.detail ?? err.code)
          : err instanceof Error
            ? err.message
            : 'Could not save phone number.',
      );
      setSaving(false);
    }
  }

  return (
    <section className="mb-6 rounded-xl border border-terracotta/30 bg-paper-warm px-4 py-3 sm:px-5">
      <form onSubmit={onSubmit} className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink">Add your WhatsApp number</p>
          <p className="text-xs text-ink/65 mt-0.5">
            Link a verified number to access locations and open gates from WhatsApp.
          </p>
          {error && <p className="text-xs text-terracotta-deep mt-1">{error}</p>}
        </div>
        <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+27821234567"
            autoComplete="tel"
            className="h-10 w-full sm:w-48 rounded-xl bg-paper border border-ink/15 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ink"
          />
          <button
            type="submit"
            disabled={saving}
            className="h-10 px-4 rounded-full bg-ink text-paper text-sm font-medium disabled:opacity-60"
          >
            {saving ? 'Saving…' : 'Add number'}
          </button>
        </div>
      </form>
    </section>
  );
}

export function PageHeader({
  kicker,
  title,
  description,
  actions,
}: {
  kicker?: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="mb-8 sm:mb-10 pb-6 sm:pb-8 border-b border-ink/10 flex flex-wrap items-end gap-x-6 gap-y-3 sm:gap-x-8 sm:gap-y-4 justify-between">
      <div className="min-w-0">
        {kicker && (
          <span className="inline-flex items-center gap-2 text-[10px] sm:text-[11px] uppercase tracking-[0.22em] text-ink/55">
            <span className="h-1 w-1 rounded-full bg-terracotta" aria-hidden />
            {kicker}
          </span>
        )}
        <h1 className="font-display-tight text-3xl sm:text-4xl lg:text-[40px] leading-[1.02] tracking-[-0.02em] mt-2">
          {title}
        </h1>
        {description && (
          <p className="mt-3 text-sm sm:text-[15px] text-ink/65 max-w-xl leading-relaxed">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex flex-wrap gap-2 self-end">{actions}</div>}
    </header>
  );
}
