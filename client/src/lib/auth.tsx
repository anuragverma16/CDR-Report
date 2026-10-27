import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
import type { Role, User } from './types';

interface AuthCtx { user: User | null; loading: boolean; login: (email: string, password: string) => Promise<void>; logout: () => Promise<void>; can: (r: Role) => boolean }
const Ctx = createContext<AuthCtx>(null as unknown as AuthCtx);
const RANK: Record<Role, number> = { viewer: 1, manager: 2, admin: 3 };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    api.get<{ user: User }>('/auth/me').then((r) => setUser(r.user)).catch(() => setUser(null)).finally(() => setLoading(false));
    const onUnauth = () => setUser(null);
    window.addEventListener('tdr:unauthorized', onUnauth);
    return () => window.removeEventListener('tdr:unauthorized', onUnauth);
  }, []);
  const login = useCallback(async (email: string, password: string) => {
    const r = await api.post<{ user: User }>('/auth/login', { email, password });
    setUser(r.user);
  }, []);
  const logout = useCallback(async () => {
    await api.post('/auth/logout').catch(() => {});
    setUser(null);
  }, []);
  const can = useCallback((r: Role) => !!user && RANK[user.role] >= RANK[r], [user]);
  return <Ctx.Provider value={{ user, loading, login, logout, can }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
