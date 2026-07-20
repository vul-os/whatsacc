import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { AuthLayout } from '@/components/auth/AuthLayout';
import { ApiError, api, friendlyApiError } from '@/lib/api';

export default function ResetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = useMemo(() => params.get('token') ?? '', [params]);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!token) setMissing(true);
  }, [token]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    if (password.length < 8) {
      setErrorMsg('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setErrorMsg('Passwords don’t match.');
      return;
    }
    setSubmitting(true);
    try {
      await api.resetPassword(token, password);
      setDone(true);
    } catch (err) {
      const msg =
        err instanceof ApiError && err.code === 'invalid_token'
          ? 'This reset link is invalid or has been replaced.'
          : err instanceof ApiError && err.code === 'token_used'
            ? 'This reset link has already been used. Request a new one.'
            : err instanceof ApiError && err.code === 'token_expired'
              ? 'This reset link has expired. Request a new one.'
              : friendlyApiError(err);
      setErrorMsg(msg);
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      asideKicker="Reset password"
      asideTitle="A fresh start."
      asideBody={
        <p>
          Choose a new password — at least 8 characters. Once you save, all your active sessions
          will be signed out.
        </p>
      }
    >
      <h1 className="font-display-tight text-[34px] sm:text-[40px] leading-[1.02] tracking-[-0.02em] text-ink">
        Set a new password
      </h1>

      {missing ? (
        <>
          <p className="mt-2 sm:mt-3 text-[15px] text-ink/65 leading-relaxed">
            This link is missing its token. Request a new reset link to continue.
          </p>
          <Button
            variant="ink"
            size="lg"
            className="mt-5 sm:mt-6 w-full"
            onClick={() => navigate('/forgot-password')}
          >
            Request new link
          </Button>
        </>
      ) : done ? (
        <>
          <p className="mt-2 sm:mt-3 text-[15px] text-ink/65 leading-relaxed">
            Your password has been updated successfully.
          </p>
          <div className="mt-5 sm:mt-6 rounded-xl bg-moss/10 border border-moss/30 px-4 py-3 text-sm text-ink/85">
            You can now sign in with your new password. All active sessions have been signed out.
          </div>
          <Button variant="ink" size="lg" className="mt-3 w-full" onClick={() => navigate('/login')}>
            Sign in
          </Button>
        </>
      ) : (
        <>
          <p className="mt-2 sm:mt-3 text-[15px] text-ink/65 leading-relaxed">
            Choose something at least 8 characters long.
          </p>
          <form onSubmit={onSubmit} className="mt-5 sm:mt-6 space-y-3 sm:space-y-4" noValidate>
            <Field
              label="New password"
              type="password"
              autoComplete="new-password"
              required
              autoFocus
              value={password}
              onChange={setPassword}
              placeholder="••••••••"
            />
            <Field
              label="Confirm password"
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={setConfirm}
              placeholder="••••••••"
              error={errorMsg}
            />
            <Button type="submit" variant="ink" size="lg" className="w-full" disabled={submitting}>
              {submitting ? 'Updating…' : 'Save new password'}
            </Button>
          </form>
          <p className="mt-5 sm:mt-6 text-sm text-ink/60">
            Need a fresh link?{' '}
            <Link to="/forgot-password" className="underline underline-offset-4 decoration-terracotta text-ink/85 hover:text-ink">
              Request a new one
            </Link>
            .
          </p>
        </>
      )}
    </AuthLayout>
  );
}
