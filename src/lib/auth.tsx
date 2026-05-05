import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, api, tokenStore, type MeResponse } from './api';

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
};

export type SessionAccount = {
  id: string;
  name: string;
  billing_type: string;
  role: string;
};

type AuthState = {
  user: SessionUser | null;
  accounts: SessionAccount[];
  currentAccount: SessionAccount | null;
  signedIn: boolean;
  loading: boolean;
  error: string | null;
  signInWithPassword: (email: string, password: string) => Promise<void>;
  registerWithPassword: (input: {
    email: string;
    password: string;
    display_name: string;
    country_code: string;
    account_type: 'personal' | 'business';
    referral_slug?: string;
  }) => Promise<void>;
  signOut: () => Promise<void>;
  setTokensFromOAuth: (access_token: string, refresh_token: string) => Promise<void>;
  refreshMe: () => Promise<void>;
};

const Ctx = createContext<AuthState | null>(null);

function toSession(me: MeResponse): { user: SessionUser; accounts: SessionAccount[] } {
  const fallbackName = me.profile?.display_name ?? me.user.email.split('@')[0] ?? me.user.email;
  return {
    user: {
      id: me.user.id,
      email: me.user.email,
      name: fallbackName,
      avatar_url: me.profile?.avatar_url ?? null,
    },
    accounts: me.accounts.map((a) => ({
      id: a.account_id,
      name: a.name,
      billing_type: a.billing_type,
      role: a.role,
    })),
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [accounts, setAccounts] = useState<SessionAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshMe = useCallback(async () => {
    if (!tokenStore.access && !tokenStore.refresh) {
      setUser(null);
      setAccounts([]);
      return;
    }
    try {
      const me = await api.me();
      const s = toSession(me);
      setUser(s.user);
      setAccounts(s.accounts);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        tokenStore.clear();
        setUser(null);
        setAccounts([]);
      } else {
        throw err;
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await refreshMe();
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshMe]);

  const signInWithPassword = useCallback(
    async (email: string, password: string) => {
      setError(null);
      const tokens = await api.login({ email, password });
      tokenStore.set(tokens.access_token, tokens.refresh_token);
      await refreshMe();
    },
    [refreshMe],
  );

  const registerWithPassword = useCallback(
    async (input: {
      email: string;
      password: string;
      display_name: string;
      country_code: string;
      account_type: 'personal' | 'business';
      referral_slug?: string;
    }) => {
      setError(null);
      await api.register(input);
      const tokens = await api.login({ email: input.email, password: input.password });
      tokenStore.set(tokens.access_token, tokens.refresh_token);
      await refreshMe();
    },
    [refreshMe],
  );

  const signOut = useCallback(async () => {
    const refresh = tokenStore.refresh;
    if (refresh) {
      try {
        await api.logout(refresh);
      } catch {
        // ignore
      }
    }
    tokenStore.clear();
    setUser(null);
    setAccounts([]);
  }, []);

  const setTokensFromOAuth = useCallback(
    async (access_token: string, refresh_token: string) => {
      tokenStore.set(access_token, refresh_token);
      await refreshMe();
    },
    [refreshMe],
  );

  const value = useMemo<AuthState>(
    () => ({
      user,
      accounts,
      currentAccount: accounts[0] ?? null,
      signedIn: user !== null,
      loading,
      error,
      signInWithPassword,
      registerWithPassword,
      signOut,
      setTokensFromOAuth,
      refreshMe,
    }),
    [
      user,
      accounts,
      loading,
      error,
      signInWithPassword,
      registerWithPassword,
      signOut,
      setTokensFromOAuth,
      refreshMe,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}
