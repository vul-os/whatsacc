import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { AuthLayout } from '@/components/auth/AuthLayout';
import { useAuth } from '@/lib/auth';
import { ApiError, api } from '@/lib/api';

const PENDING_INVITE_KEY = 'lintel.pendingInviteToken';

type Status = 'idle' | 'accepting' | 'success' | 'error' | 'no-token' | 'needs-auth';

export default function AcceptInvite() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { user, refreshMe } = useAuth();
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [phone, setPhone] = useState('');

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

    setStatus('idle');
  }, [token, user]);

  async function handleAccept() {
    if (!token) return;
    setStatus('accepting');
    setErrorMsg(null);

    try {
      await api.inviteAccept(token, phone.trim() || undefined);
      try { sessionStorage.removeItem(PENDING_INVITE_KEY); } catch {/**/}
      await refreshMe();
      setStatus('success');
      setTimeout(() => navigate('/app', { replace: true }), 800);
    } catch (err) {
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
                  : err.code === 'invite_phone_required'
                    ? 'Add your WhatsApp number to accept this invitation.'
                    : err.code === 'invite_phone_mismatch'
                      ? 'Use the same WhatsApp number this invitation was sent to.'
                  : (err.detail ?? err.code)
        : err instanceof Error ? err.message : 'Failed to accept invitation.';
      setErrorMsg(msg);
      setStatus('error');
    }
  }

  return (
    <AuthLayout
      asideKicker="Team up"
      asideTitle="One step away from joining."
      asideBody={
        <p>
          Accept the invitation to start opening gates and managing access for the team that
          invited you.
        </p>
      }
    >
      <h1 className="font-display-tight text-[34px] sm:text-[40px] leading-[1.02] tracking-[-0.02em] text-ink">
        Accept invitation
      </h1>

      {status === 'no-token' && (
        <>
          <p className="mt-2 sm:mt-3 text-[15px] text-ink/65 leading-relaxed">
            This link doesn't carry an invitation token. Ask the sender to forward you the
            original email.
          </p>
          <p className="mt-5 sm:mt-6 text-sm text-ink/60">
            Already have an account?{' '}
            <Link
              to="/login"
              className="underline underline-offset-4 decoration-terracotta text-ink/85 hover:text-ink"
            >
              Sign in
            </Link>
            .
          </p>
        </>
      )}

      {status === 'needs-auth' && (
        <>
          <p className="mt-2 sm:mt-3 text-[15px] text-ink/65 leading-relaxed">
            Sign in or create an account first — your invitation will be applied automatically
            once you're authenticated.
          </p>
          <Button
            variant="ink"
            size="lg"
            className="mt-5 sm:mt-7 w-full"
            onClick={() => navigate('/signup')}
          >
            Create account
          </Button>
          <p className="mt-5 sm:mt-6 text-sm text-ink/60">
            Already have an account?{' '}
            <Link
              to="/login"
              className="underline underline-offset-4 decoration-terracotta text-ink/85 hover:text-ink"
            >
              Sign in
            </Link>
            .
          </p>
        </>
      )}

      {status === 'idle' && (
        <>
          <p className="mt-2 sm:mt-3 text-[15px] text-ink/65 leading-relaxed">
            You've been invited to join the team. Confirm your details below to accept and start
            opening gates.
          </p>
          <div className="mt-5 sm:mt-7 space-y-4">
            <Field
              label="WhatsApp phone number"
              type="tel"
              value={phone}
              onChange={setPhone}
              placeholder="+27..."
              hint="Optional — enter in E.164 format to open gates via text"
            />
            <Button
              variant="ink"
              size="lg"
              className="w-full"
              onClick={handleAccept}
            >
              Accept and join team
            </Button>
          </div>
        </>
      )}

      {status === 'accepting' && (
        <>
          <p className="mt-2 sm:mt-3 text-[15px] text-ink/65 leading-relaxed">
            Accepting your invitation…
          </p>
          <div className="mt-5 sm:mt-6 flex items-center gap-3">
            <span
              className="h-4 w-4 rounded-full border-2 border-ink/20 border-t-ink animate-spin shrink-0"
              aria-hidden
            />
            <p className="text-sm text-ink/70">Just a moment…</p>
          </div>
        </>
      )}

      {status === 'success' && (
        <>
          <p className="mt-2 sm:mt-3 text-[15px] text-ink/65 leading-relaxed">
            You're in. Taking you to the dashboard…
          </p>
          <Button
            variant="ink"
            size="lg"
            className="mt-5 sm:mt-7 w-full"
            onClick={() => navigate('/app', { replace: true })}
          >
            Go to dashboard
          </Button>
        </>
      )}

      {status === 'error' && (
        <>
          <p className="mt-2 sm:mt-3 text-[15px] text-terracotta-deep leading-relaxed">
            {errorMsg}
          </p>
          <p className="mt-5 sm:mt-6 text-sm text-ink/60">
            <Link
              to="/app"
              className="underline underline-offset-4 decoration-terracotta text-ink/85 hover:text-ink"
            >
              Continue to dashboard →
            </Link>
          </p>
        </>
      )}
    </AuthLayout>
  );
}
