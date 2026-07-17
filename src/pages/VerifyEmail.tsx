import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { AuthLayout } from '@/components/auth/AuthLayout';
import { ApiError, api } from '@/lib/api';

type Status = 'verifying' | 'success' | 'missing' | 'error';

export default function VerifyEmail() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = useMemo(() => params.get('token') ?? '', [params]);
  const [status, setStatus] = useState<Status>(token ? 'verifying' : 'missing');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (!token || ran.current) return;
    ran.current = true;
    api
      .verifyEmail(token)
      .then(() => setStatus('success'))
      .catch((err: unknown) => {
        const msg =
          err instanceof ApiError
            ? err.code === 'invalid_token'
              ? 'This verification link is invalid.'
              : err.code === 'token_used'
                ? 'This email has already been verified. You can sign in.'
                : err.code === 'token_expired'
                  ? 'This verification link has expired. Sign in to request a new one.'
                  : (err.detail ?? err.code)
            : err instanceof Error
              ? err.message
              : 'Something went wrong.';
        setErrorMsg(msg);
        setStatus('error');
      });
  }, [token]);

  return (
    <AuthLayout
      asideKicker="Verify email"
      asideTitle="One quick confirm."
      asideBody={
        <p>
          Click the link we sent and your account is live — no password, just your number and a
          message.
        </p>
      }
    >
      <h1 className="font-display-tight text-[34px] sm:text-[40px] leading-[1.02] tracking-[-0.02em] text-ink">
        Email verification
      </h1>

      {status === 'verifying' && (
        <>
          <p className="mt-2 sm:mt-3 text-[15px] text-ink/65 leading-relaxed">
            This only takes a moment.
          </p>
          <p className="mt-5 sm:mt-6 inline-flex items-center gap-2.5 text-[13px] uppercase tracking-[0.18em] text-ink/55">
            <span className="h-1.5 w-1.5 rounded-full bg-terracotta animate-pulse" aria-hidden />
            Verifying your link&hellip;
          </p>
        </>
      )}

      {status === 'missing' && (
        <>
          <p className="mt-2 sm:mt-3 text-[15px] text-ink/65 leading-relaxed">
            This link is missing its token. Open the verification link from your email, or sign in
            to request a new one.
          </p>
          <Button variant="ink" size="lg" className="mt-5 sm:mt-6 w-full" onClick={() => navigate('/login')}>
            Go to sign in
          </Button>
        </>
      )}

      {status === 'success' && (
        <>
          <p className="mt-2 sm:mt-3 text-[15px] text-ink/65 leading-relaxed">
            Your email is verified — welcome aboard.
          </p>
          <div className="mt-5 sm:mt-6 rounded-xl bg-moss/10 border border-moss/25 px-4 py-3.5 text-[15px] text-ink/85 leading-relaxed">
            You can now sign in with your account.
          </div>
          <Button variant="ink" size="lg" className="mt-3 w-full" onClick={() => navigate('/login')}>
            Sign in
          </Button>
        </>
      )}

      {status === 'error' && (
        <>
          <p className="mt-2 sm:mt-3 text-[15px] text-ink/65 leading-relaxed">
            There was a problem with your verification link.
          </p>
          <p className="mt-4 text-[15px] text-terracotta-deep leading-relaxed" role="alert">
            {errorMsg}
          </p>
          <Button variant="ink" size="lg" className="mt-5 sm:mt-6 w-full" onClick={() => navigate('/login')}>
            Go to sign in
          </Button>
        </>
      )}

      <p className="mt-5 sm:mt-6 text-sm text-ink/55">
        Trouble?{' '}
        <Link to="/login" className="underline underline-offset-4 decoration-terracotta hover:text-ink/80 transition-colors">
          Sign in
        </Link>
        {' '}and we'll resend the link.
      </p>
    </AuthLayout>
  );
}
