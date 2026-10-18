import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { db } from './db';

export interface Profile { id: string; email: string | null; full_name: string | null; avatar_url: string | null; is_blocked: boolean }
interface SessionLike {
  access_token: string;
  user: { id: string; email?: string; user_metadata?: Record<string, unknown> };
}

interface AuthState {
  loading: boolean;
  session: SessionLike | null;
  profile: Profile | null;
  roles: string[];
  isAdmin: boolean;
  error: string | null;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionLike | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Creates/updates the profile on the server and returns roles (sync_profile).
  const loadUser = useCallback(async (s: SessionLike | null) => {
    if (!s) { setProfile(null); setRoles([]); return; }
    const meta = s.user.user_metadata ?? {};
    const { data, error: err } = await db.rpc('sync_profile', {
      p_name: (meta.displayName ?? meta.name ?? null) as string | null,
      p_avatar: (meta.profileImageUrl ?? meta.image ?? null) as string | null,
    });
    if (err) { setError(err.message); return; }
    const d = data as { roles: string[]; profile: Profile };
    setProfile(d.profile);
    setRoles(d.roles ?? []);
    setError(null);
  }, []);

  useEffect(() => {
    let active = true;
    db.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      const s = (data.session as SessionLike | null) ?? null;
      setSession(s);
      await loadUser(s).catch((e: Error) => setError(e.message));
      setLoading(false);
    }).catch((e: Error) => { if (active) { setError(e.message); setLoading(false); } });
    const { data: sub } = db.auth.onAuthStateChange((event, s) => {
      setSession((s as SessionLike | null) ?? null);
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') {
        setTimeout(() => { void loadUser((s as SessionLike | null) ?? null); }, 0);
      }
    });
    return () => { active = false; sub.subscription.unsubscribe(); };
  }, [loadUser]);

  const value = useMemo<AuthState>(() => ({
    loading, session, profile, roles, error, isAdmin: roles.includes('admin'),
    signInWithGoogle: async () => {
      const { error: err } = await db.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: `${window.location.origin}${import.meta.env.BASE_URL}` } });
      if (err) throw err;
    },
    signOut: async () => { await db.auth.signOut(); setSession(null); setProfile(null); setRoles([]); },
    refresh: async () => loadUser(session),
  }), [loading, session, profile, roles, error, loadUser]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
