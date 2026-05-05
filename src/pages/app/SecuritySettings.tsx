import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from './AppLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth';

export default function SecuritySettings() {
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    if (next.length < 8) {
      setErrorMsg('New password must be at least 8 characters.');
      return;
    }
    if (next !== confirm) {
      setErrorMsg('New passwords don’t match.');
      return;
    }
    setSubmitting(true);
    try {
      await api.updatePassword(current, next);
      setDone(true);
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.code === 'invalid_current_password'
            ? 'Current password is incorrect.'
            : err.code === 'same_password'
              ? 'New password must be different from the current one.'
              : err.code === 'no_password_set'
                ? 'This account uses Google sign-in. Set a password from the security flow.'
                : (err.detail ?? err.code)
          : err instanceof Error
            ? err.message
            : 'Could not update password.';
      setErrorMsg(msg);
    } finally {
      setSubmitting(false);
    }
  }

  async function signOutEverywhere() {
    await signOut();
    navigate('/login', { replace: true });
  }

  return (
    <>
      <PageHeader
        kicker="Account"
        title="Security"
        description="Manage your password. Updating it will sign you out of every session except this one."
      />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 max-w-3xl">
        <Card className="lg:col-span-12">
          <h2 className="font-display text-2xl">Change password</h2>
          <p className="text-sm text-ink/65 mt-1">
            Other browsers and devices will need to sign in again with the new password.
          </p>

          {done && (
            <div className="mt-5 rounded-xl bg-moss/10 border border-moss/30 px-4 py-3 text-sm text-ink/85">
              Password updated. You stay signed in here; other sessions are gone.
            </div>
          )}

          <form onSubmit={onSubmit} className="mt-5 space-y-4">
            <Field
              label="Current password"
              value={current}
              onChange={setCurrent}
              type="password"
              autoComplete="current-password"
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field
                label="New password"
                value={next}
                onChange={setNext}
                type="password"
                autoComplete="new-password"
                hint="8+ chars"
              />
              <Field
                label="Confirm new password"
                value={confirm}
                onChange={setConfirm}
                type="password"
                autoComplete="new-password"
              />
            </div>

            {errorMsg && (
              <p className="text-sm text-terracotta-deep" role="alert">
                {errorMsg}
              </p>
            )}

            <div className="flex flex-wrap gap-3 pt-2">
              <Button type="submit" variant="ink" disabled={submitting}>
                {submitting ? 'Updating…' : 'Update password'}
              </Button>
              <button
                type="button"
                onClick={signOutEverywhere}
                className="h-11 px-5 rounded-full text-sm text-ink/65 hover:text-terracotta-deep underline underline-offset-4"
              >
                Sign out of this session
              </button>
            </div>
          </form>
        </Card>
      </div>
    </>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  type = 'text',
  autoComplete,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  autoComplete?: string;
}) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between mb-1.5">
        <span className="text-sm font-medium text-ink/85">{label}</span>
        {hint && <span className="text-xs text-ink/50">{hint}</span>}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        required
        className="w-full h-11 rounded-xl bg-paper-cool border border-ink/15 px-4 text-[15px] focus:outline-none focus:ring-2 focus:ring-ink"
      />
    </label>
  );
}
