import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { AuthLayout } from '@/components/auth/AuthLayout';
import { useAuth } from '@/lib/auth';
import { ApiError, api } from '@/lib/api';

const PENDING_INVITE_KEY = 'whatsacc.pendingInviteToken';

type Status = 'idle' | 'accepting' | 'success' | 'error' | 'no-token' | 'needs-auth';

export default function AcceptInvite() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { user, refreshMe } = useAuth();
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Pull the token from URL or sessionStorage. The latter is set when the
  // visitor wasn't signed in yet — we stash and bounce them through signup.
  const tokenFromUrl = params.get('token');
  const token =
    tokenFromUrl ??
    (typeof window !== 'undefined' ? sessionStorage.getItem(PENDING_INVITE_KEY) : null);

  useEffect(() => {
    if (!token) {
      setStatus('no-token');
      return;
    }

    if (!user) {
      // Visitor isn't signed in. Stash the token so we can pick it back up
      // after they finish signup/login, then send them to signup with the
      // invite-context preserved.
      try {
        sessionStorage.setItem(PENDING_INVITE_KEY, token);
      } catch {/* private mode */}
      setStatus('needs-auth');
      return;
    }

    let cancelled = false;
    setStatus('accepting');
    setErrorMsg(null);

    api.inviteAccept(token)
      .then(async () => {
        try { sessionStorage.removeItem(PENDING_INVITE_KEY); } catch {/**/}
        await refreshMe();
        if (!cancelled) {
          setStatus('success');
          setTimeout(() => navigate('/app', { replace: true }), 800);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = err instanceof ApiError
          ? err.code === 'invite_email_mismatch'
            ? 'This invitation was sent to a different email address. Sign in with that account to accept.'
            : err.code === 'invite_used'
              ? 'This invitation has already been accepted.'
              : err.code === 'invite_revoked'
                ? 'This invitation was revoked by the sender.'
                : err.code === 'invite_expired'
                  ? 'This invitation has expired. Ask the sender to send a new one.'
                  : err.code === 'invite_not_found'
                    ? 'We couldn\'t find this invitation. The link may be wrong.'
                    : (err.detail ?? err.code)
          : err instanceof Error ? err.message : 'Failed to accept invitation.';
        setErrorMsg(msg);
        setStatus('error');
      });

    return () => { cancelled = true; };
  }, [token, user, navigate, refreshMe]);

  return (
    <AuthLayout
      asideOrder="last"
      asideKicker="Team up"
      asideTitle="One step away from joining."
      asideBody={
        <p>
          Accept the invitation to start opening gates and managing access for the team that
          invited you.
        </p>
      }
    >
      <h1 className="font-display-tight text-3xl sm:text-4xl">Accept invitation</h1>

      {status === 'no-token' && (
        <>
          <p className="mt-4 text-sm text-ink/70">
            This link doesn't carry an invitation token. Ask the sender to forward you the
            original email.
          </p>
          <Link
            to="/login"
            className="mt-6 inline-block underline underline-offset-4 decoration-terracotta text-sm"
          >
            Or sign in to your account →
          </Link>
        </>
      )}

      {status === 'needs-auth' && (
        <>
          <p className="mt-4 text-sm text-ink/70">
            Sign in or create an account first — your invitation will be applied automatically
            once you're authenticated.
          </p>
          <Button
            variant="ink"
            size="lg"
            className="mt-6 w-full"
            onClick={() => navigate('/signup')}
          >
            Create account
          </Button>
          <p className="mt-3 text-sm text-ink/65">
            Already have an account?{' '}
            <Link to="/login" className="underline underline-offset-4 decoration-terracotta">
              Sign in
            </Link>
            .
          </p>
        </>
      )}

      {status === 'accepting' && (
        <p className="mt-4 text-sm text-ink/70">Accepting your invitation…</p>
      )}

      {status === 'success' && (
        <>
          <p className="mt-4 text-sm text-ink/70">
            You're in. Taking you to the dashboard…
          </p>
          <Button
            variant="ink"
            size="lg"
            className="mt-6 w-full"
            onClick={() => navigate('/app', { replace: true })}
          >
            Go to dashboard
          </Button>
        </>
      )}

      {status === 'error' && (
        <>
          <p className="mt-4 text-sm text-terracotta-deep">{errorMsg}</p>
          <Link
            to="/app"
            className="mt-6 inline-block underline underline-offset-4 decoration-terracotta text-sm"
          >
            Continue to dashboard →
          </Link>
        </>
      )}
    </AuthLayout>
  );
}
