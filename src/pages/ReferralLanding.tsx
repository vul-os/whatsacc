import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArchMark } from '@/components/illustrations/ArchMark';
import { Button, LinkButton } from '@/components/ui/Button';
import { api } from '@/lib/api';
import { setReferral } from '@/lib/referral';

export default function ReferralLanding() {
  const { slug = '' } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ok'; displayName: string }
    | { kind: 'invalid' }
  >({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    api
      .referralResolve(slug)
      .then((r) => {
        if (cancelled) return;
        setReferral(r.slug, r.display_name);
        setState({ kind: 'ok', displayName: r.display_name });
        const t = setTimeout(() => navigate('/signup', { replace: true }), 1500);
        return () => clearTimeout(t);
      })
      .catch(() => {
        if (cancelled) return;
        setState({ kind: 'invalid' });
      });
    return () => {
      cancelled = true;
    };
  }, [slug, navigate]);

  return (
    <div className="min-h-screen bg-paper grid place-items-center px-6">
      <div className="max-w-md w-full text-center">
        <Link to="/" className="inline-flex items-center gap-2.5 mb-10">
          <ArchMark className="h-9 w-9 text-ink" />
          <span className="font-display italic text-2xl">whatsacc</span>
        </Link>

        {state.kind === 'loading' && (
          <p className="text-ink/55 text-sm uppercase tracking-[0.22em]">Checking invite…</p>
        )}

        {state.kind === 'ok' && (
          <>
            <p className="text-[11px] uppercase tracking-[0.22em] text-ink/55 mb-4">
              You were invited
            </p>
            <p className="font-display-tight text-4xl sm:text-5xl leading-[1.05]">
              <span className="block">{state.displayName}</span>
              <span className="block text-ink/55 text-2xl mt-2">sent you here.</span>
            </p>
            <p className="mt-6 text-ink/65 leading-relaxed">
              Sign up and start opening gates over WhatsApp. The first 100 messages are on us.
            </p>
            <LinkButton to="/signup" variant="ink" size="lg" className="mt-8">
              Continue to sign up
            </LinkButton>
          </>
        )}

        {state.kind === 'invalid' && (
          <>
            <p className="font-display-tight text-3xl">That invite link isn’t live</p>
            <p className="mt-3 text-ink/65 max-w-sm mx-auto">
              The slug isn’t recognised. You can still create an account directly.
            </p>
            <Button variant="ink" size="lg" className="mt-8" onClick={() => navigate('/signup')}>
              Sign up
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
