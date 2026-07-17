import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { AuthLayout } from '@/components/auth/AuthLayout';
import { api } from '@/lib/api';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    setSubmitting(true);
    try {
      await api.forgotPassword(email.trim().toLowerCase());
      setSent(true);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not send the reset email.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      asideKicker="Forgot password"
      asideTitle="We’ll send you a link."
      asideBody={
        <p>
          If an account exists for the email you enter, we’ll deliver a one-hour reset link there.
          Check your spam folder if it doesn’t show up.
        </p>
      }
    >
      <h1 className="font-display-tight text-[34px] sm:text-[40px] leading-[1.02] tracking-[-0.02em] text-ink">
        Reset your password
      </h1>
      {!sent && (
        <p className="mt-2 sm:mt-3 text-[15px] text-ink/65 leading-relaxed">
          Enter the email you signed up with — we&rsquo;ll email you a reset link.
        </p>
      )}

      {sent ? (
        <div className="mt-5 sm:mt-6 space-y-3 sm:space-y-4">
          <div className="rounded-xl bg-signal/[0.08] border border-signal/25 px-5 py-4 text-sm text-ink/85">
            <p className="font-medium text-ink">Check your inbox.</p>
            <p className="mt-1.5 leading-relaxed text-ink/70">
              If <span className="font-medium text-ink">{email}</span> is on file, the reset link is
              on its way. It expires in one hour — check your spam folder too.
            </p>
          </div>
          <Button variant="outline" size="lg" className="w-full" onClick={() => setSent(false)}>
            Try a different address
          </Button>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="mt-5 sm:mt-6 space-y-3 sm:space-y-4" noValidate>
          <Field
            label="Email"
            type="email"
            autoComplete="email"
            required
            autoFocus
            value={email}
            onChange={setEmail}
            placeholder="you@example.com"
            error={errorMsg}
          />

          <Button type="submit" variant="ink" size="lg" className="w-full" disabled={submitting}>
            {submitting ? 'Sending…' : 'Send reset link'}
          </Button>
        </form>
      )}

      <p className="mt-5 sm:mt-6 text-sm text-ink/60">
        Remembered it?{' '}
        <Link to="/login" className="underline underline-offset-4 decoration-terracotta text-ink/85 hover:text-ink">
          Sign in
        </Link>
        .
      </p>
    </AuthLayout>
  );
}
