import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';
import type { Role, User } from './types';

/** Network drops and gateway errors (the API waking up or restarting) are retried; a wrong password or a rate limit is not. */
const RETRY_STATUS = [502, 503, 504];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await api.post<{ user: User }>('/auth/login', { email, password });
        setUser(r.user);
        return;
      } catch (e) {
        const transient = !(e instanceof ApiError) || RETRY_STATUS.includes(e.status);
        if (!transient || attempt >= 3) throw e;
        await sleep(1500 * attempt); // 1.5 s, then 3 s
      }
    }
  }, []);
  const logout = useCallback(async () => {
    await api.post('/auth/logout').catch(() => {});
    setUser(null);
  }, []);
  const can = useCallback((r: Role) => !!user && RANK[user.role] >= RANK[r], [user]);
  return <Ctx.Provider value={{ user, loading, login, logout, can }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
