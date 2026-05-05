import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { ArchMark } from '@/components/illustrations/ArchMark';
import { useAuth } from '@/lib/auth';

export default function Login() {
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const { signIn } = useAuth();
  const navigate = useNavigate();

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    console.log('login', { phone, pin });
    signIn({ phone });
    navigate('/app');
  }

  return (
    <div className="min-h-screen grid grid-cols-1 lg:grid-cols-12 bg-paper">
      <aside className="lg:col-span-5 bg-ink text-paper relative overflow-hidden">
        <div className="absolute inset-0 grain pointer-events-none" />
        <div className="relative h-full flex flex-col p-10">
          <Link to="/" className="inline-flex items-center gap-2.5">
            <ArchMark className="h-8 w-8 text-paper" />
            <span className="font-display italic text-xl">whatsacc</span>
          </Link>

          <div className="mt-auto">
            <p className="text-[11px] uppercase tracking-[0.22em] text-paper/55 mb-4">
              Welcome back
            </p>
            <p className="font-display-tight text-5xl leading-[0.95] max-w-md">
              The gate is just inside.
            </p>
          </div>
        </div>
      </aside>

      <main className="lg:col-span-7 flex items-center">
        <div className="w-full max-w-md mx-auto px-6 py-16">
          <h1 className="font-display-tight text-4xl">Sign in</h1>
          <p className="mt-2 text-ink/60">
            Use the WhatsApp number you signed up with.
          </p>

          <form onSubmit={onSubmit} className="mt-10 space-y-5">
            <Field
              label="WhatsApp number"
              hint="With country code"
              value={phone}
              onChange={setPhone}
              placeholder="+27 82 555 0144"
            />
            <Field
              label="One-time PIN"
              hint="Sent to your WhatsApp"
              value={pin}
              onChange={setPin}
              placeholder="------"
            />

            <Button type="submit" variant="ink" size="lg" className="w-full">
              Continue
            </Button>
          </form>

          <p className="mt-8 text-sm text-ink/60">
            New here?{' '}
            <Link to="/signup" className="underline underline-offset-4 decoration-terracotta">
              Create an account
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
