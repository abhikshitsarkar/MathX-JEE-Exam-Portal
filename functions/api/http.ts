// Shared HTTP helpers: errors, CORS, caller authentication.
import { fetchWithToken, NeonPostgrestClient } from '@neondatabase/postgrest-js';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export type Db = NeonPostgrestClient;

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

const allowed = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  const allow = allowed.length === 0 || allowed.includes('*') ? (origin || '*') : allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } });
}

// ---- Neon Auth token verification (EdDSA JWT, verified against the branch JWKS)
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function keySet() {
  const url = process.env.NEON_AUTH_JWKS_URL;
  if (!url) throw new HttpError(500, 'NEON_AUTH_JWKS_URL is not configured. Enable Neon Auth on this branch.');
  jwks ??= createRemoteJWKSet(new URL(url));
  return jwks;
}

export interface Caller { userId: string; email: string | null; token: string; db: Db }

function dataApiUrl(): string {
  const raw = (process.env.NEON_DATA_API_URL ?? '').replace(/\/+$/, '');
  if (!raw) throw new HttpError(500, 'NEON_DATA_API_URL is not configured. Enable the Data API on this branch.');
  return /\/rest\/v1$/.test(raw) ? raw : `${raw}/rest/v1`;
}

/** Verifies the caller's Neon Auth token and returns a Data API client acting as them. */
export async function authenticate(req: Request): Promise<Caller> {
  const header = req.headers.get('authorization') ?? '';
  if (!/^bearer\s+/i.test(header)) throw new HttpError(401, 'Sign in required.');
  const token = header.replace(/^bearer\s+/i, '');
  let payload;
  try {
    const issuer = process.env.NEON_AUTH_ISSUER ?? (process.env.NEON_AUTH_BASE_URL ? new URL(process.env.NEON_AUTH_BASE_URL).origin : undefined);
    ({ payload } = await jwtVerify(token, keySet(), issuer ? { issuer } : {}));
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(401, 'Your session has expired. Sign in again.');
  }
  if (typeof payload.sub !== 'string' || !payload.sub) throw new HttpError(401, 'Invalid session.');
  const db = new NeonPostgrestClient({
    dataApiUrl: dataApiUrl(),
    options: { global: { fetch: fetchWithToken(async () => token) } },
  });
  return { userId: payload.sub, email: typeof payload.email === 'string' ? payload.email : null, token, db };
}

export async function isAdmin(c: Caller): Promise<boolean> {
  const { data } = await c.db.from('user_roles').select('role').eq('user_id', c.userId).eq('role', 'admin').maybeSingle();
  return !!data;
}
