import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { AuthLayout } from '@/components/auth/AuthLayout';
import { useAuth } from '@/lib/auth';
import { ApiError, api, type CountryRef } from '@/lib/api';
import { clearReferral, getReferral } from '@/lib/referral';

export default function Signup() {
  const [name, setName] = useState('');
  const [locationName, setLocationName] = useState('');
  const [locationTouched, setLocationTouched] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [country, setCountry] = useState('ZA');
  const [kind, setKind] = useState<'personal' | 'business'>('personal');
  const [countries, setCountries] = useState<CountryRef[]>([]);
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

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    setSubmitting(true);
    try {
      await registerWithPassword({
        email,
        password,
        display_name: name,
        // If the user didn't touch the location field, fall back to "Home"
        // so they don't get stuck on a required-field error.
        location_name: (locationTouched ? locationName : locationName || 'Home').trim(),
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
      asideKicker="Get started"
      asideTitle="First gate is on us."
      asideBody={
        <p>
          The free signup is real. Create your account, set up your locations, and pair a device
          when you’re ready.
        </p>
      }
    >
      {submittedEmail ? (
        <>
          <h1 className="font-display-tight text-3xl sm:text-4xl">Check your email</h1>
          <p className="mt-3 text-sm text-ink/70">
            We sent a verification link to{' '}
            <span className="font-medium text-ink">{submittedEmail}</span>. Click it to activate
            your account, then sign in.
          </p>
          <div className="mt-6 rounded-xl bg-paper-cool border border-ink/10 px-4 py-3 text-sm text-ink/70">
            The link expires in 24 hours. Check your spam folder if it doesn't arrive within a
            minute.
          </div>
          <Button
            variant="ink"
            size="lg"
            className="mt-6 w-full"
            onClick={() => navigate('/login')}
          >
            Go to sign in
          </Button>
          <p className="mt-5 text-sm text-ink/60">
            Wrong email?{' '}
            <button
              type="button"
              onClick={() => setSubmittedEmail(null)}
              className="underline underline-offset-4 decoration-terracotta"
            >
              Sign up again
            </button>
            .
          </p>
        </>
      ) : (
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
        className="mt-5 flex items-center justify-center gap-3 h-11 rounded-full border border-ink/20 hover:border-ink hover:bg-ink hover:text-paper transition-colors"
      >
        <GoogleMark />
        <span className="text-sm font-medium">Continue with Google</span>
      </a>

      <div className="my-4 flex items-center gap-3 text-[10px] uppercase tracking-[0.22em] text-ink/45">
        <span className="flex-1 h-px bg-ink/15" />
        or sign up with email
        <span className="flex-1 h-px bg-ink/15" />
      </div>

      <form onSubmit={onSubmit} className="space-y-3">
        <Field
          label="Your name"
          value={name}
          onChange={setName}
          placeholder="e.g. Yusuf Adams"
          autoComplete="name"
          required
        />

        <Field
          label="Location name"
          hint="house / complex / building you'll manage"
          value={locationTouched ? locationName : locationName || 'Home'}
          onChange={(v) => { setLocationName(v); setLocationTouched(true); }}
          placeholder="e.g. Home, Sunset Apartments"
          autoComplete="address-level2"
          required
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
            hint="8+ chars"
            value={password}
            onChange={setPassword}
            placeholder="••••••••"
            autoComplete="new-password"
            required
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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

          <fieldset>
            <legend className="text-sm font-medium text-ink/85 mb-1.5">Account type</legend>
            <div className="grid grid-cols-2 gap-2">
              {(['personal', 'business'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={`h-11 rounded-xl border text-sm capitalize transition-colors ${
                    kind === k
                      ? 'bg-ink text-paper border-ink'
                      : 'bg-paper-cool text-ink border-ink/15 hover:border-ink/35'
                  }`}
                >
                  {k}
                </button>
              ))}
            </div>
          </fieldset>
        </div>

        {errorMsg && (
          <p className="text-sm text-terracotta-deep" role="alert">
            {errorMsg}
          </p>
        )}

        <Button type="submit" variant="ink" size="lg" className="w-full mt-4" disabled={submitting}>
          {submitting ? 'Creating account…' : 'Create account'}
        </Button>
      </form>

      <p className="mt-5 text-sm text-ink/60">
        Already with us?{' '}
        <Link to="/login" className="underline underline-offset-4 decoration-terracotta">
          Sign in
        </Link>
        .
      </p>
        </>
      )}
    </AuthLayout>
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
