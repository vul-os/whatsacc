import { useState, type FormEvent } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { AppSidebar } from '@/components/nav/AppSidebar';
import { AppTopBar } from '@/components/nav/AppTopBar';
import { useAuth } from '@/lib/auth';
import { ApiError, api } from '@/lib/api';

const DISMISSED_BANNERS_KEY = 'whatsacc.dismissedBanners';

export default function AppLayout() {
  const { signedIn, loading, user } = useAuth();
  const [dismissedBanners, setDismissedBanners] = useState<string[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      return JSON.parse(window.localStorage.getItem(DISMISSED_BANNERS_KEY) ?? '[]') as string[];
    } catch {
      return [];
    }
  });

  function dismissBanner(key: string) {
    setDismissedBanners((prev) => {
      const next = prev.includes(key) ? prev : [...prev, key];
      try { window.localStorage.setItem(DISMISSED_BANNERS_KEY, JSON.stringify(next)); } catch {/**/}
      return next;
    });
  }

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
          {user && !user.has_verified_phone && !dismissedBanners.includes('whatsapp') && (
            <WhatsAppNumberBanner onDismiss={() => dismissBanner('whatsapp')} />
          )}
          {user && !user.has_slack_identity && !dismissedBanners.includes('slack') && (
            <SlackIdentityBanner onDismiss={() => dismissBanner('slack')} />
          )}
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function WhatsAppNumberBanner({ onDismiss }: { onDismiss: () => void }) {
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
          <button
            type="button"
            onClick={onDismiss}
            className="h-10 px-3 rounded-full text-sm text-ink/55 hover:text-ink"
            aria-label="Dismiss WhatsApp number banner"
          >
            Dismiss
          </button>
        </div>
      </form>
    </section>
  );
}

function SlackIdentityBanner({ onDismiss }: { onDismiss: () => void }) {
  const { refreshMe } = useAuth();
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmed = value.trim().replace(/^@+/, '');
    if (!trimmed) {
      setError('Enter your Slack user ID or handle.');
      return;
    }

    const upper = trimmed.toUpperCase();
    const body = /^[UW][A-Z0-9]{2,32}$/.test(upper)
      ? { slack_user_id: upper }
      : { slack_handle: trimmed };

    setSaving(true);
    try {
      await api.slackUpdate(body);
      await refreshMe();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? (err.detail ?? err.code)
          : err instanceof Error
            ? err.message
            : 'Could not save Slack identity.',
      );
      setSaving(false);
    }
  }

  return (
    <section className="mb-6 rounded-xl border border-moss/30 bg-paper-cool px-4 py-3 sm:px-5">
      <form onSubmit={onSubmit} className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink">Add your Slack identity</p>
          <p className="text-xs text-ink/65 mt-0.5">
            Link Slack so the bot can welcome you, show the menu, and route access commands.
          </p>
          {error && <p className="text-xs text-terracotta-deep mt-1">{error}</p>}
        </div>
        <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="@name or U123ABC"
            autoComplete="off"
            className="h-10 w-full sm:w-48 rounded-xl bg-paper border border-ink/15 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ink"
          />
          <button
            type="submit"
            disabled={saving}
            className="h-10 px-4 rounded-full bg-ink text-paper text-sm font-medium disabled:opacity-60"
          >
            {saving ? 'Saving…' : 'Add Slack'}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="h-10 px-3 rounded-full text-sm text-ink/55 hover:text-ink"
            aria-label="Dismiss Slack identity banner"
          >
            Dismiss
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
