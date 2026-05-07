import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { AuthLayout } from '@/components/auth/AuthLayout';
import { useAuth } from '@/lib/auth';
import { ApiError, api, type CountryRef } from '@/lib/api';
import { clearReferral, getReferral } from '@/lib/referral';

type Step = 'auth' | 'kind' | 'location';
const STEPS: Array<{ key: Step; label: string }> = [
  { key: 'auth', label: 'Account' },
  { key: 'kind', label: 'Type' },
  { key: 'location', label: 'Location' },
];

export default function Signup() {
  const [step, setStep] = useState<Step>('auth');

  // Step 1 — auth basics
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // Step 2 — account kind
  const [kind, setKind] = useState<'personal' | 'business'>('personal');

  // Step 3 — first location
  const [locationName, setLocationName] = useState('');
  const [locationType, setLocationType] = useState<'house' | 'complex' | 'building' | 'other'>('house');
  const [country, setCountry] = useState('ZA');
  const [countries, setCountries] = useState<CountryRef[]>([]);

  // Submission + flow
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(null);
  const { registerWithPassword } = useAuth();
  const navigate = useNavigate();

  const referral = useMemo(() => getReferral(), []);
  const googleUrl = referral
    ? `${api.googleStartUrl()}?ref=${encodeURIComponent(referral.slug)}`
    : api.googleStartUrl();

  useEffect(() => {
    let cancelled = false;
    api
      .countries()
      .then((r) => !cancelled && setCountries(r.countries))
      .catch(() => {
        if (!cancelled) {
          setCountries([
            { code: 'ZA', name: 'South Africa', flag: '🇿🇦', currency_code: 'ZAR', msg_cost_zar: 0.148 },
          ]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Smart default: personal account → "Home", business → user's name + " HQ"
  const placeholderForKind =
    kind === 'business' ? (name ? `${name} HQ` : 'Sunset Apartments') : 'Home';

  const canAdvanceFromAuth =
    name.trim().length > 0 && /.+@.+\..+/.test(email) && password.length >= 8;

  function gotoNext() {
    setErrorMsg(null);
    if (step === 'auth') {
      if (!canAdvanceFromAuth) {
        setErrorMsg('Fill in your name, a valid email, and a password (8+ chars).');
        return;
      }
      setStep('kind');
    } else if (step === 'kind') {
      setStep('location');
    }
  }
  function gotoBack() {
    setErrorMsg(null);
    if (step === 'kind') setStep('auth');
    else if (step === 'location') setStep('kind');
  }

  async function onFinalSubmit(e: FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    setSubmitting(true);
    try {
      await registerWithPassword({
        email,
        password,
        display_name: name,
        location_name: (locationName.trim() || placeholderForKind).trim(),
        country_code: country,
        account_type: kind,
        referral_slug: referral?.slug,
      });
      clearReferral();
      setSubmittedEmail(email);
    } catch (err) {
      setErrorMsg(toMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      asideOrder="last"
      asideKicker={step === 'location' ? 'Almost there' : 'Get started'}
      asideTitle={
        step === 'auth'
          ? 'First gate is on us.'
          : step === 'kind'
            ? 'Personal or for the team?'
            : 'Name your first place.'
      }
      asideBody={
        <p>
          {step === 'auth' &&
            "The free signup is real. Three quick steps and you'll be ready to pair a device."}
          {step === 'kind' &&
            "It's only for billing copy and dashboard hints — you can change it later in settings."}
          {step === 'location' &&
            'Each location is its own world: members, billing, gates. You can add more after you sign up.'}
        </p>
      }
    >
      {submittedEmail ? (
        <SuccessPanel
          email={submittedEmail}
          onSignIn={() => navigate('/login')}
          onRedo={() => setSubmittedEmail(null)}
        />
      ) : (
        <>
          <Stepper current={step} />

          {/* ── Step 1: auth ───────────────────────────────────────────── */}
          {step === 'auth' && (
            <>
              <h1 className="font-display-tight text-3xl sm:text-4xl">Create your account</h1>
              <p className="mt-2 text-sm text-ink/60">Two minutes. No credit card.</p>

              {referral && (
                <p className="mt-4 px-3 py-2 rounded-xl bg-moss/10 border border-moss/30 text-sm text-ink/80">
                  You were invited by{' '}
                  <span className="font-medium">{referral.displayName ?? referral.slug}</span>.
                </p>
              )}

              <a
                href={googleUrl}
                className="mt-6 flex items-center justify-center gap-3 h-11 rounded-full border border-ink/20 hover:border-ink hover:bg-ink hover:text-paper transition-colors"
              >
                <GoogleMark />
                <span className="text-sm font-medium">Continue with Google</span>
              </a>

              <div className="my-5 flex items-center gap-3 text-[10px] uppercase tracking-[0.22em] text-ink/45">
                <span className="flex-1 h-px bg-ink/15" />
                or sign up with email
                <span className="flex-1 h-px bg-ink/15" />
              </div>

              <div className="space-y-3">
                <Field
                  label="Your name"
                  value={name}
                  onChange={setName}
                  placeholder="e.g. Yusuf Adams"
                  autoComplete="name"
                  required
                />
                <Field
                  label="Email"
                  type="email"
                  value={email}
                  onChange={setEmail}
                  placeholder="you@example.com"
                  autoComplete="email"
                  required
                />
                <Field
                  label="Password"
                  type="password"
                  hint="8+ characters"
                  value={password}
                  onChange={setPassword}
                  placeholder="••••••••"
                  autoComplete="new-password"
                  required
                />
              </div>

              {errorMsg && (
                <p className="mt-4 text-sm text-terracotta-deep" role="alert">
                  {errorMsg}
                </p>
              )}

              <Button
                type="button"
                variant="ink"
                size="lg"
                className="w-full mt-6"
                onClick={gotoNext}
                disabled={!canAdvanceFromAuth}
              >
                Continue →
              </Button>

              <p className="mt-5 text-sm text-ink/60">
                Already with us?{' '}
                <Link to="/login" className="underline underline-offset-4 decoration-terracotta">
                  Sign in
                </Link>
                .
              </p>
            </>
          )}

          {/* ── Step 2: account kind ───────────────────────────────────── */}
          {step === 'kind' && (
            <>
              <h1 className="font-display-tight text-3xl sm:text-4xl">What is this for?</h1>
              <p className="mt-2 text-sm text-ink/60">
                We tailor the dashboard a little. You can switch later.
              </p>

              <div className="mt-6 grid grid-cols-1 gap-3">
                <KindCard
                  selected={kind === 'personal'}
                  onClick={() => setKind('personal')}
                  title="Personal"
                  body="A house, a cottage, a small place. Invite a few friends or your cleaner."
                  icon={
                    <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 11 12 4l9 7" />
                      <path d="M5 10v10h14V10" />
                      <path d="M10 20v-5h4v5" />
                    </svg>
                  }
                />
                <KindCard
                  selected={kind === 'business'}
                  onClick={() => setKind('business')}
                  title="Business"
                  body="A complex, an office, a property you manage. Multiple gates, members, billing."
                  icon={
                    <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="6" width="18" height="14" rx="1.5" />
                      <path d="M3 10h18" />
                      <path d="M9 14h2M13 14h2M9 17h2M13 17h2" />
                      <path d="M9 6V4h6v2" />
                    </svg>
                  }
                />
              </div>

              {errorMsg && <p className="mt-4 text-sm text-terracotta-deep">{errorMsg}</p>}

              <div className="mt-7 flex items-center gap-3">
                <button
                  type="button"
                  onClick={gotoBack}
                  className="h-11 px-4 rounded-full text-sm text-ink/65 hover:text-ink"
                >
                  ← Back
                </button>
                <Button
                  type="button"
                  variant="ink"
                  size="lg"
                  className="flex-1"
                  onClick={gotoNext}
                >
                  Continue →
                </Button>
              </div>
            </>
          )}

          {/* ── Step 3: first location ─────────────────────────────────── */}
          {step === 'location' && (
            <form onSubmit={onFinalSubmit}>
              <h1 className="font-display-tight text-3xl sm:text-4xl">Your first location</h1>
              <p className="mt-2 text-sm text-ink/60">
                Each location has its own gates, members and billing. You can add more after.
              </p>

              <div className="mt-6 space-y-3">
                <Field
                  label="Location name"
                  value={locationName}
                  onChange={setLocationName}
                  placeholder={placeholderForKind}
                  autoComplete="address-level2"
                  hint="what you'd call it day-to-day"
                  required={false}
                />

                <fieldset>
                  <legend className="text-sm font-medium text-ink/85 mb-2">Type</legend>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {(['house', 'complex', 'building', 'other'] as const).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setLocationType(t)}
                        className={`h-11 rounded-xl border text-sm capitalize transition-colors ${
                          locationType === t
                            ? 'bg-ink text-paper border-ink'
                            : 'bg-paper-cool text-ink border-ink/15 hover:border-ink/35'
                        }`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </fieldset>

                <label className="block">
                  <span className="text-sm font-medium text-ink/85 block mb-1.5">Country</span>
                  <select
                    value={country}
                    onChange={(e) => setCountry(e.target.value)}
                    className="w-full h-11 rounded-xl bg-paper-cool border border-ink/15 px-3 text-[15px] focus:outline-none focus:ring-2 focus:ring-ink"
                  >
                    {countries.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.flag} {c.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {errorMsg && (
                <p className="mt-4 text-sm text-terracotta-deep" role="alert">
                  {errorMsg}
                </p>
              )}

              <div className="mt-7 flex items-center gap-3">
                <button
                  type="button"
                  onClick={gotoBack}
                  className="h-11 px-4 rounded-full text-sm text-ink/65 hover:text-ink"
                >
                  ← Back
                </button>
                <Button
                  type="submit"
                  variant="ink"
                  size="lg"
                  className="flex-1"
                  disabled={submitting}
                >
                  {submitting ? 'Creating account…' : 'Create account'}
                </Button>
              </div>
            </form>
          )}
        </>
      )}
    </AuthLayout>
  );
}

// ─── pieces ──────────────────────────────────────────────────────────────

function Stepper({ current }: { current: Step }) {
  const idx = STEPS.findIndex((s) => s.key === current);
  return (
    <ol className="mb-8 flex items-center gap-3">
      {STEPS.map((s, i) => {
        const state = i < idx ? 'done' : i === idx ? 'active' : 'upcoming';
        return (
          <li key={s.key} className="flex items-center gap-3 flex-1">
            <span
              className={`flex-none grid place-items-center h-8 w-8 rounded-full text-xs font-medium ${
                state === 'done'
                  ? 'bg-terracotta text-paper'
                  : state === 'active'
                    ? 'bg-ink text-paper'
                    : 'bg-paper-cool text-ink/45 border border-ink/10'
              }`}
            >
              {state === 'done' ? (
                <svg viewBox="0 0 16 16" className="h-3.5 w-3.5"><path d="M3 8l3 3 7-7" stroke="currentColor" strokeWidth="2" fill="none" /></svg>
              ) : (
                i + 1
              )}
            </span>
            <span
              className={`text-[11px] uppercase tracking-[0.18em] ${
                state === 'upcoming' ? 'text-ink/35' : 'text-ink/65'
              }`}
            >
              {s.label}
            </span>
            {i < STEPS.length - 1 && (
              <span
                className={`hidden sm:block flex-1 h-px ${
                  state === 'done' ? 'bg-terracotta/40' : 'bg-ink/10'
                }`}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function KindCard({
  selected,
  onClick,
  title,
  body,
  icon,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  body: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left rounded-2xl border p-5 transition-all ${
        selected
          ? 'border-ink bg-paper-cool ring-2 ring-ink/10'
          : 'border-ink/10 hover:border-ink/30 hover:bg-paper-cool/50'
      }`}
      aria-pressed={selected}
    >
      <div className="flex items-start gap-4">
        <div
          className={`flex-none grid place-items-center h-12 w-12 rounded-xl ${
            selected ? 'bg-ink text-paper' : 'bg-paper-cool text-ink/65'
          }`}
        >
          {icon}
        </div>
        <div className="flex-1">
          <p className="font-display text-xl">{title}</p>
          <p className="text-sm text-ink/65 mt-1">{body}</p>
        </div>
        <span
          className={`flex-none mt-1 grid place-items-center h-6 w-6 rounded-full border ${
            selected ? 'border-ink bg-ink' : 'border-ink/20'
          }`}
        >
          {selected && (
            <svg viewBox="0 0 16 16" className="h-3 w-3 text-paper">
              <path d="M3 8l3 3 7-7" stroke="currentColor" strokeWidth="2.5" fill="none" />
            </svg>
          )}
        </span>
      </div>
    </button>
  );
}

function SuccessPanel({
  email,
  onSignIn,
  onRedo,
}: {
  email: string;
  onSignIn: () => void;
  onRedo: () => void;
}) {
  return (
    <>
      <h1 className="font-display-tight text-3xl sm:text-4xl">You're in.</h1>
      <p className="mt-3 text-sm text-ink/70">
        Signed up as <span className="font-medium text-ink">{email}</span>. Hit sign-in below to
        jump into your dashboard.
      </p>
      <div className="mt-6 rounded-xl bg-paper-cool border border-ink/10 px-4 py-3 text-sm text-ink/70">
        We sent a verification link too — clicking it confirms your email but isn't required to
        sign in.
      </div>
      <Button variant="ink" size="lg" className="mt-6 w-full" onClick={onSignIn}>
        Go to sign in
      </Button>
      <p className="mt-5 text-sm text-ink/60">
        Wrong email?{' '}
        <button
          type="button"
          onClick={onRedo}
          className="underline underline-offset-4 decoration-terracotta"
        >
          Sign up again
        </button>
        .
      </p>
    </>
  );
}

function toMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'email_taken') return 'That email is already in use. Try signing in.';
    if (err.code === 'invalid_credentials') return 'Could not sign in after registration.';
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
