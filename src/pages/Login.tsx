import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { AuthLayout } from '@/components/auth/AuthLayout';
import { useAuth } from '@/lib/auth';
import { ApiError, api } from '@/lib/api';

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
    >
      <h1 className="font-display-tight text-3xl sm:text-4xl">Sign in</h1>
      <p className="mt-2 text-sm text-ink/60">
        Use your email and password, or continue with Google.
      </p>

      <a
        href={api.googleStartUrl()}
        className="mt-6 flex items-center justify-center gap-3 h-11 rounded-full border border-ink/20 hover:border-ink hover:bg-ink hover:text-paper transition-colors"
      >
        <GoogleMark />
        <span className="text-sm font-medium">Continue with Google</span>
      </a>

      <div className="my-5 flex items-center gap-3 text-[10px] uppercase tracking-[0.22em] text-ink/45">
        <span className="flex-1 h-px bg-ink/15" />
        or
        <span className="flex-1 h-px bg-ink/15" />
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={setEmail}
          placeholder="you@example.com"
          required
        />
        <div>
          <div className="flex items-baseline justify-between mb-1.5">
            <span className="text-sm font-medium text-ink/85">Password</span>
            <Link
              to="/forgot-password"
              className="text-xs text-ink/60 hover:text-ink underline underline-offset-4 decoration-terracotta"
            >
              Forgot?
            </Link>
          </div>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            required
            className="w-full h-11 rounded-xl bg-paper-cool border border-ink/15 px-4 text-[15px] focus:outline-none focus:ring-2 focus:ring-ink"
          />
        </div>

        {errorMsg && (
          <p className="text-sm text-terracotta-deep" role="alert">
            {errorMsg}
          </p>
        )}

        <Button type="submit" variant="ink" size="lg" className="w-full" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      <p className="mt-6 text-sm text-ink/60">
        New here?{' '}
        <Link to="/signup" className="underline underline-offset-4 decoration-terracotta">
          Create an account
        </Link>
        .
      </p>
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

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
  type = 'text',
  autoComplete,
  required,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  autoComplete?: string;
  required?: boolean;
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
        placeholder={placeholder}
        autoComplete={autoComplete}
        required={required}
        className="w-full h-11 rounded-xl bg-paper-cool border border-ink/15 px-4 text-[15px] focus:outline-none focus:ring-2 focus:ring-ink"
      />
    </label>
  );
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
