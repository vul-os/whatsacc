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
  has_verified_phone: boolean;
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
  setCurrentAccount: (accountId: string) => void;
  signedIn: boolean;
  loading: boolean;
  error: string | null;
  signInWithPassword: (email: string, password: string) => Promise<void>;
  registerWithPassword: (input: {
    email: string;
    password: string;
    display_name: string;
    phone_e164?: string;
    location_name?: string;
    country_code: string;
    account_type: 'personal' | 'business';
    referral_slug?: string;
    invite_token?: string;
  }) => Promise<void>;
  signOut: () => Promise<void>;
  setTokensFromOAuth: (access_token: string, refresh_token: string) => Promise<void>;
  refreshMe: () => Promise<void>;
};

const ACTIVE_ACCOUNT_KEY = 'whatsacc.activeAccount';

const Ctx = createContext<AuthState | null>(null);

function toSession(me: MeResponse): { user: SessionUser; accounts: SessionAccount[] } {
  const fallbackName = me.profile?.display_name ?? me.user.email.split('@')[0] ?? me.user.email;
  return {
    user: {
      id: me.user.id,
      email: me.user.email,
      name: fallbackName,
      avatar_url: me.profile?.avatar_url ?? null,
      has_verified_phone: me.phones.some((p) => p.verified_at !== null),
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
  const [activeAccountId, setActiveAccountIdState] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    try { return window.localStorage.getItem(ACTIVE_ACCOUNT_KEY); } catch { return null; }
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const setCurrentAccount = useCallback((accountId: string) => {
    setActiveAccountIdState(accountId);
    try { window.localStorage.setItem(ACTIVE_ACCOUNT_KEY, accountId); } catch {/**/}
  }, []);

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
      phone_e164?: string;
      location_name?: string;
      country_code: string;
      account_type: 'personal' | 'business';
      referral_slug?: string;
      invite_token?: string;
    }) => {
      setError(null);
      const tokens = await api.register(input);
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

  const currentAccount = useMemo(() => {
    if (accounts.length === 0) return null;
    if (activeAccountId) {
      const match = accounts.find((a) => a.id === activeAccountId);
      if (match) return match;
    }
    // Fallback: first account on the list (preserves existing behaviour for
    // single-org users and bootstraps a sensible default for new sessions).
    return accounts[0] ?? null;
  }, [accounts, activeAccountId]);

  const value = useMemo<AuthState>(
    () => ({
      user,
      accounts,
      currentAccount,
      setCurrentAccount,
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
      currentAccount,
      setCurrentAccount,
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
