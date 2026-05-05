import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { ArchMark } from '@/components/illustrations/ArchMark';
import { useAuth } from '@/lib/auth';

export default function Signup() {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [kind, setKind] = useState<'personal' | 'business'>('personal');
  const { signIn } = useAuth();
  const navigate = useNavigate();

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    console.log('signup', { name, phone, kind });
    signIn({ name, phone });
    navigate('/app');
  }

  return (
    <div className="min-h-screen grid grid-cols-1 lg:grid-cols-12 bg-paper">
      <aside className="lg:col-span-5 bg-ink text-paper relative order-last lg:order-first overflow-hidden">
        <div className="absolute inset-0 grain pointer-events-none" />
        <div className="relative h-full flex flex-col p-10">
          <Link to="/" className="inline-flex items-center gap-2.5">
            <ArchMark className="h-8 w-8 text-paper" />
            <span className="font-display italic text-xl">whatsacc</span>
          </Link>

          <div className="mt-auto">
            <p className="text-[11px] uppercase tracking-[0.22em] text-paper/55 mb-4">
              Create an account
            </p>
            <p className="font-display-tight text-5xl leading-[0.95] max-w-md">
              First gate is on us.
            </p>
            <p className="mt-6 text-paper/65 max-w-md leading-relaxed">
              The free plan is real. 100 messages a month, 1 location, 1 device. Most homeowners
              never need more.
            </p>
          </div>
        </div>
      </aside>

      <main className="lg:col-span-7 flex items-center">
        <div className="w-full max-w-md mx-auto px-6 py-16">
          <h1 className="font-display-tight text-4xl">Create your account</h1>
          <p className="mt-2 text-ink/60">Two minutes. No credit card.</p>

          <form onSubmit={onSubmit} className="mt-10 space-y-5">
            <Field label="Your name" value={name} onChange={setName} placeholder="e.g. Yusuf Adams" />
            <Field
              label="WhatsApp number"
              hint="With country code"
              value={phone}
              onChange={setPhone}
              placeholder="+27 82 555 0144"
            />

            <fieldset>
              <legend className="text-sm font-medium text-ink/85 mb-2">Account type</legend>
              <div className="grid grid-cols-2 gap-3">
                {(['personal', 'business'] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setKind(k)}
                    className={`h-12 rounded-xl border text-sm capitalize transition-colors ${
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

            <Button type="submit" variant="ink" size="lg" className="w-full">
              Create account
            </Button>
          </form>

          <p className="mt-8 text-sm text-ink/60">
            Already with us?{' '}
            <Link to="/login" className="underline underline-offset-4 decoration-terracotta">
              Sign in
            </Link>
            .
          </p>
        </div>
      </main>
    </div>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between">
        <span className="text-sm font-medium text-ink/85">{label}</span>
        {hint && <span className="text-xs text-ink/50">{hint}</span>}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1.5 w-full h-12 rounded-xl bg-paper-cool border border-ink/15 px-4 text-[15px] focus:outline-none focus:ring-2 focus:ring-ink"
      />
    </label>
  );
}
