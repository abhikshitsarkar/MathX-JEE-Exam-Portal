import { createClient, SupabaseAuthAdapter } from '@neondatabase/neon-js';

// Public values from the Neon Console (Auth URL, Data API URL) and the URL of
// the deployed `api` Neon Function. None of these are secrets.
const authUrl = import.meta.env.VITE_NEON_AUTH_URL as string | undefined;
const dataApiUrl = import.meta.env.VITE_NEON_DATA_API_URL as string | undefined;
export const API_URL = ((import.meta.env.VITE_API_URL as string | undefined) ?? '').replace(/\/+$/, '');

/** False until the Neon Auth and Data API URLs are set at build time. */
export const isConfigured = Boolean(authUrl && dataApiUrl);

/**
 * Neon client: `.from()` / `.rpc()` query the Data API as the signed-in user
 * (the JWT is attached automatically), `.auth` is Neon Auth with a
 * Supabase-compatible API (getSession, onAuthStateChange, signInWithOAuth).
 */
export const db = createClient({
  auth: { url: authUrl || 'https://not-configured.invalid/auth', adapter: SupabaseAuthAdapter() },
  dataApi: { url: dataApiUrl || 'https://not-configured.invalid/rest/v1' },
});

export const APP_NAME = (import.meta.env.VITE_APP_NAME as string | undefined) || 'MathX Test Series';

/** Current Neon Auth JWT, or null when signed out. */
export async function accessToken(): Promise<string | null> {
  const { data } = await db.auth.getSession();
  return data.session?.access_token || null;
}
