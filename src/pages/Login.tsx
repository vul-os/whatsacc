import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { AuthLayout } from '@/components/auth/AuthLayout';
import { useAuth } from '@/lib/auth';
import { ApiError, api } from '@/lib/api';
import { getApiBaseUrl, getStoredGatewayUrl, isTauri, openGatewayPicker } from '@/lib/gateway';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const { signInWithPassword } = useAuth();
  const navigate = useNavigate();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    setSubmitting(true);
    try {
      await signInWithPassword(email, password);
      navigate('/app');
    } catch (err) {
      setErrorMsg(toMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      asideKicker="Welcome back"
      asideTitle="The gate is just inside."
      asideBody={
        <p>
          Sign in to open access points, manage members, and review activity from anywhere.
        </p>
      }
    >
      <h1 className="font-display-tight text-[34px] sm:text-[40px] leading-[1.02] tracking-[-0.02em] text-ink">
        Sign in
      </h1>
      <p className="mt-2 sm:mt-3 text-[15px] text-ink/65 leading-relaxed">
        {isTauri()
          ? 'Use your email and password to sign in.'
          : 'Use your email and password, or continue with Google.'}
      </p>

      {isTauri() ? (
        // The Google OAuth redirect flow can't complete inside the desktop
        // webview against an arbitrary gateway — password sign-in only here.
        <div
          aria-disabled="true"
          title="Google sign-in isn’t available in the desktop app — use email + password."
          className="mt-5 sm:mt-7 flex items-center justify-center gap-3 h-11 rounded-full border border-ink/15 bg-paper-cool/40 opacity-45 cursor-not-allowed select-none"
        >
          <GoogleMark />
          <span className="text-sm font-medium">Continue with Google</span>
        </div>
      ) : (
        <a
          href={api.googleStartUrl()}
          className="mt-5 sm:mt-7 flex items-center justify-center gap-3 h-11 rounded-full border border-ink/20 bg-paper-cool/40 hover:border-ink hover:bg-ink hover:text-paper transition-colors"
        >
          <GoogleMark />
          <span className="text-sm font-medium">Continue with Google</span>
        </a>
      )}

      <div className="my-5 sm:my-6 flex items-center gap-3 text-[10px] uppercase tracking-[0.22em] text-ink/45">
        <span className="flex-1 h-px bg-ink/12" />
        or
        <span className="flex-1 h-px bg-ink/12" />
      </div>

      <form onSubmit={onSubmit} className="space-y-3 sm:space-y-4" noValidate>
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={setEmail}
          placeholder="you@example.com"
          required
          autoFocus
        />
        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={setPassword}
          placeholder="••••••••"
          required
          labelTrailing={
            <Link
              to="/forgot-password"
              className="text-xs text-ink/60 hover:text-ink underline underline-offset-4 decoration-terracotta"
            >
              Forgot?
            </Link>
          }
        />

        {errorMsg && (
          <p className="text-sm text-terracotta-deep" role="alert">
            {errorMsg}
          </p>
        )}

        <Button type="submit" variant="ink" size="lg" className="w-full" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      <p className="mt-5 sm:mt-6 text-sm text-ink/60">
        New here?{' '}
        <Link to="/signup" className="underline underline-offset-4 decoration-terracotta text-ink/85 hover:text-ink">
          Create an account
        </Link>
        .
      </p>

      {/* Desktop builds (or anyone who explicitly picked a gateway) can point
          this portal at a different gateway. Plain web deploys stay untouched. */}
      {(isTauri() || getStoredGatewayUrl() !== null) && (
        <p className="mt-3 text-xs text-ink/45">
          Gateway: <span className="text-ink/60">{getApiBaseUrl()}</span>{' '}
          <button
            type="button"
            onClick={openGatewayPicker}
            className="underline underline-offset-4 decoration-terracotta text-ink/70 hover:text-ink"
          >
            change
          </button>
        </p>
      )}
    </AuthLayout>
  );
}

function toMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'invalid_credentials') return 'That email and password don’t match.';
    if (err.code === 'account_not_active') return 'Verify your email before signing in.';
    return err.detail ?? err.code;
  }
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" className="h-4 w-4" aria-hidden>
      <path fill="#EA4335" d="M9 3.48c1.7 0 2.86.74 3.52 1.36l2.6-2.54C13.46 0.95 11.43 0 9 0 5.48 0 2.44 2.02 0.96 4.96l3.02 2.34C4.7 5.07 6.66 3.48 9 3.48Z" />
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.13 4.13 0 0 1-1.8 2.71l2.92 2.27c1.71-1.58 2.68-3.91 2.68-6.62Z" />
      <path fill="#FBBC05" d="M3.96 10.71A5.4 5.4 0 0 1 3.68 9c0-.59.1-1.16.28-1.7L0.96 4.96A9 9 0 0 0 0 9c0 1.46.35 2.83.96 4.04l3-2.33Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.27c-.81.55-1.86.87-3.04.87-2.34 0-4.31-1.59-5.02-3.72L0.96 13.04C2.44 15.98 5.48 18 9 18Z" />
    </svg>
  );
}
