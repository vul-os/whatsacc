import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

type User = { name: string; phone: string; email: string };

type AuthState = {
  user: User | null;
  signedIn: boolean;
  signIn: (u?: Partial<User>) => void;
  signOut: () => void;
};

const Ctx = createContext<AuthState | null>(null);

const DEMO_USER: User = {
  name: 'Yusuf Adams',
  phone: '+27 82 555 0144',
  email: 'yusuf@whatsacc.demo',
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(DEMO_USER);

  const signIn = useCallback((u?: Partial<User>) => {
    setUser({ ...DEMO_USER, ...u });
  }, []);

  const signOut = useCallback(() => setUser(null), []);

  const value = useMemo<AuthState>(
    () => ({ user, signedIn: user !== null, signIn, signOut }),
    [user, signIn, signOut],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}
