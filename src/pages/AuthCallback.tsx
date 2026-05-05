import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';

export default function AuthCallback() {
  const { setTokensFromOAuth } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fragment = window.location.hash.replace(/^#/, '');
    const params = new URLSearchParams(fragment);
    const access = params.get('access_token');
    const refresh = params.get('refresh_token');
    if (!access || !refresh) {
      setError('Missing tokens from OAuth response.');
      return;
    }
    // Strip the tokens out of the URL before any later render exposes them.
    window.history.replaceState(null, '', '/auth/callback');
    setTokensFromOAuth(access, refresh)
      .then(() => navigate('/app', { replace: true }))
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : 'Failed to complete sign-in.'),
      );
  }, [navigate, setTokensFromOAuth]);

  return (
    <div className="min-h-screen bg-paper grid place-items-center px-6">
      <div className="text-center">
        {error ? (
          <>
            <p className="font-display-tight text-3xl">Sign-in didn’t complete</p>
            <p className="mt-3 text-ink/65 max-w-sm">{error}</p>
            <button
              type="button"
              onClick={() => navigate('/login')}
              className="mt-6 underline underline-offset-4 decoration-terracotta text-sm"
            >
              Back to sign in
            </button>
          </>
        ) : (
          <p className="text-ink/55 text-sm uppercase tracking-[0.22em]">Signing you in…</p>
        )}
      </div>
    </div>
  );
}
