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
    <div className="min-h-screen bg-paper relative grid place-items-center px-6">
      <span className="hidden sm:block absolute top-6 left-6 h-3 w-3 border-l border-t border-ink/20" aria-hidden />
      <span className="hidden sm:block absolute top-6 right-6 h-3 w-3 border-r border-t border-ink/20" aria-hidden />
      <span className="hidden sm:block absolute bottom-6 left-6 h-3 w-3 border-l border-b border-ink/20" aria-hidden />
      <span className="hidden sm:block absolute bottom-6 right-6 h-3 w-3 border-r border-b border-ink/20" aria-hidden />

      <div className="max-w-md w-full text-center">
        <Link to="/" className="inline-flex items-center gap-2.5 mb-12 group">
          <ArchMark className="h-9 w-9 text-ink transition-transform group-hover:-translate-y-0.5" />
          <span className="font-display italic text-2xl">whatsacc</span>
        </Link>

        {state.kind === 'loading' && (
          <p className="inline-flex items-center gap-2 text-ink/55 text-[11px] uppercase tracking-[0.22em]">
            <span className="h-1 w-1 rounded-full bg-terracotta animate-pulse" aria-hidden />
            Checking invite&hellip;
          </p>
        )}

        {state.kind === 'ok' && (
          <>
            <span className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-ink/55 mb-5">
              <span className="h-1 w-1 rounded-full bg-terracotta" aria-hidden />
              You were invited
            </span>
            <p className="font-display-tight text-4xl sm:text-[52px] leading-[0.98] tracking-[-0.02em]">
              <span className="block">{state.displayName}</span>
              <span className="block italic font-display text-ink/55 text-2xl sm:text-3xl mt-2">
                sent you here.
              </span>
            </p>
            <p className="mt-7 text-ink/65 leading-relaxed text-[15px]">
              Sign up and start opening gates over WhatsApp. The first 100 messages are on us.
            </p>
            <LinkButton to="/signup" variant="ink" size="lg" className="mt-8">
              Continue to sign up
            </LinkButton>
          </>
        )}

        {state.kind === 'invalid' && (
          <>
            <span className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-ink/55 mb-5">
              <span className="h-1 w-1 rounded-full bg-terracotta" aria-hidden />
              Invite not found
            </span>
            <p className="font-display-tight text-3xl sm:text-4xl leading-[1.02] tracking-[-0.02em]">
              That invite link isn&rsquo;t live.
            </p>
            <p className="mt-4 text-ink/65 leading-relaxed text-[15px] max-w-sm mx-auto">
              The slug isn&rsquo;t recognised. You can still create an account directly.
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
