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
          We're checking the link you clicked. Once verified, your account is active and you can
          sign in.
        </p>
      }
    >
      <h1 className="font-display-tight text-3xl sm:text-4xl">Email verification</h1>

      {status === 'verifying' && (
        <p className="mt-3 text-sm text-ink/65">Verifying your email…</p>
      )}

      {status === 'missing' && (
        <>
          <p className="mt-3 text-sm text-ink/65">
            This link is missing its token. Open the verification link from your email, or sign in
            to request a new one.
          </p>
          <Button variant="ink" size="lg" className="mt-6" onClick={() => navigate('/login')}>
            Go to sign in
          </Button>
        </>
      )}

      {status === 'success' && (
        <>
          <div className="mt-6 rounded-xl bg-moss/10 border border-moss/30 px-4 py-3 text-sm text-ink/85">
            Your email is verified. You can now sign in.
          </div>
          <Button variant="ink" size="lg" className="mt-6 w-full" onClick={() => navigate('/login')}>
            Sign in
          </Button>
        </>
      )}

      {status === 'error' && (
        <>
          <p className="mt-3 text-sm text-terracotta-deep" role="alert">
            {errorMsg}
          </p>
          <Button variant="ink" size="lg" className="mt-6 w-full" onClick={() => navigate('/login')}>
            Go to sign in
          </Button>
        </>
      )}

      <p className="mt-6 text-sm text-ink/60">
        Trouble?{' '}
        <Link to="/login" className="underline underline-offset-4 decoration-terracotta">
          Sign in
        </Link>
        {' '}and we'll resend the link.
      </p>
    </AuthLayout>
  );
}
