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
  avatar_cdn_url: string | null;
  avatar_source: 'google' | 'user' | null;
  has_verified_phone: boolean;
  has_slack_identity: boolean;
  has_password: boolean;
  slack_user_id: string | null;
  slack_handle: string | null;
};

export type SessionAccount = {
  id: string;
  name: string;
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
    invite_token?: string;
  }) => Promise<void>;
  signOut: () => Promise<void>;
  setTokensFromOAuth: (access_token: string, refresh_token: string) => Promise<void>;
  refreshMe: () => Promise<void>;
};

const ACTIVE_ACCOUNT_KEY = 'whatsacc.activeAccount';
// Cached /me response for instant rehydration on refresh. Bumping the version
// invalidates older shapes (e.g. when SessionUser gains/loses a field) so
// stale caches don't mis-render the UI on the next deploy.
const ME_CACHE_KEY = 'whatsacc.me.v4';

type CachedMe = { user: SessionUser; accounts: SessionAccount[] };

function readMeCache(): CachedMe | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(ME_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedMe;
    if (!parsed?.user || !Array.isArray(parsed.accounts)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeMeCache(value: CachedMe | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (value) window.localStorage.setItem(ME_CACHE_KEY, JSON.stringify(value));
    else window.localStorage.removeItem(ME_CACHE_KEY);
  } catch {/**/}
}

const Ctx = createContext<AuthState | null>(null);

function toSession(me: MeResponse): { user: SessionUser; accounts: SessionAccount[] } {
  const fallbackName = me.profile?.display_name ?? me.user.email.split('@')[0] ?? me.user.email;
  return {
    user: {
      id: me.user.id,
      email: me.user.email,
      name: fallbackName,
      avatar_url: me.profile?.avatar_url ?? null,
      avatar_cdn_url: me.profile?.avatar_cdn_url ?? null,
      avatar_source: me.profile?.avatar_source ?? null,
      has_verified_phone: me.phones.some((p) => p.verified_at !== null),
      has_password: me.user.has_password,
      has_slack_identity: Boolean(me.profile?.slack_user_id || me.profile?.slack_handle),
      slack_user_id: me.profile?.slack_user_id ?? null,
      slack_handle: me.profile?.slack_handle ?? null,
    },
    accounts: me.accounts.map((a) => ({
      id: a.account_id,
      name: a.name,
      role: a.role,
    })),
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  // Hydrate from the previous session's /me snapshot so the app shell paints
  // immediately on refresh. The real /me runs in the background and replaces
  // the cache when it returns. Tokens still need to be valid; if /me 401s
  // the cache is wiped along with the user state.
  const [cached] = useState<CachedMe | null>(() =>
    typeof window !== 'undefined' && (tokenStore.access || tokenStore.refresh)
      ? readMeCache()
      : null,
  );
  const [user, setUser] = useState<SessionUser | null>(cached?.user ?? null);
  const [accounts, setAccounts] = useState<SessionAccount[]>(cached?.accounts ?? []);
  const [activeAccountId, setActiveAccountIdState] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    try { return window.localStorage.getItem(ACTIVE_ACCOUNT_KEY); } catch { return null; }
  });
  // Only show the loading shell when we have nothing to render yet. With a
  // cached snapshot the app boots straight to its real content.
  const [loading, setLoading] = useState(cached === null);
  const [error, setError] = useState<string | null>(null);

  const setCurrentAccount = useCallback((accountId: string) => {
    setActiveAccountIdState(accountId);
    try { window.localStorage.setItem(ACTIVE_ACCOUNT_KEY, accountId); } catch {/**/}
  }, []);

  const refreshMe = useCallback(async () => {
    if (!tokenStore.access && !tokenStore.refresh) {
      setUser(null);
      setAccounts([]);
      writeMeCache(null);
      return;
    }
    try {
      const me = await api.me();
      const s = toSession(me);
      setUser(s.user);
      setAccounts(s.accounts);
      writeMeCache(s);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        tokenStore.clear();
        setUser(null);
        setAccounts([]);
        writeMeCache(null);
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
    writeMeCache(null);
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
