// Local stand-in for Neon's hosted services, used ONLY for end-to-end tests:
//   /rest/v1/*  → a real PostgREST (the Neon Data API speaks the same protocol)
//   /auth/*     → minimal Neon Auth (Better Auth) endpoints: get-session with the
//                 signed JWT in the `set-auth-jwt` header, sign-out, JWKS
// Sessions come from an `e2e_user` cookie set by the test. Never deploy this.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';

const PORT = Number(process.env.GATEWAY_PORT ?? 54321);
const PGRST = process.env.PGRST_URL ?? 'http://127.0.0.1:3001';
const ISSUER = `http://127.0.0.1:${PORT}`;
const users = JSON.parse(fs.readFileSync(process.env.E2E_USERS, 'utf8'));

// RS256 signing key; the public JWKS is written for PostgREST and served at /auth/jwks
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'e2e-key', alg: 'RS256', use: 'sig' };
fs.writeFileSync(process.env.E2E_JWKS, JSON.stringify({ keys: [jwk] }));

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function signJwt(claims) {
  const head = b64({ alg: 'RS256', typ: 'JWT', kid: 'e2e-key' });
  const body = b64(claims);
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}

function cors(req) {
  return {
    'access-control-allow-origin': req.headers.origin ?? '*',
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': req.headers['access-control-request-headers'] ?? 'authorization, content-type, apikey, x-client-info, prefer, accept-profile, content-profile',
    'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS, HEAD',
    'access-control-expose-headers': 'set-auth-jwt, content-range, x-neon-client-info',
    vary: 'origin',
  };
}
const send = (req, res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...cors(req), ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
};
const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
const cookie = (req, name) => (req.headers.cookie ?? '').split(';').map((s) => s.trim().split('=')).find(([k]) => k === name)?.[1];

async function proxy(req, res, target) {
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
  const headers = { ...req.headers };
  delete headers.host; delete headers['content-length']; delete headers.cookie; delete headers.origin;
  const r = await fetch(target, { method: req.method, headers, body });
  const out = Buffer.from(await r.arrayBuffer());
  const h = { ...cors(req) };
  r.headers.forEach((v, k) => { if (!['content-encoding', 'transfer-encoding', 'connection', 'content-length'].includes(k) && !k.startsWith('access-control')) h[k] = v; });
  res.writeHead(r.status, h);
  res.end(out);
}

http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, cors(req)); res.end(); return; }
    const url = new URL(req.url, ISSUER);
    const path = url.pathname;
    if (path.startsWith('/rest/v1/')) return await proxy(req, res, `${PGRST}${path.slice('/rest/v1'.length)}${url.search}`);

    if (path === '/auth/jwks') return send(req, res, 200, { keys: [jwk] });
    if (path === '/auth/get-session' || path === '/auth/token') {
      const u = users[cookie(req, 'e2e_user') ?? ''];
      if (!u) return send(req, res, 200, null);
      const now = Math.floor(Date.now() / 1000);
      const jwt = signJwt({ sub: u.id, email: u.email, email_verified: true, role: 'authenticated', iss: ISSUER, iat: now, exp: now + 900 });
      const iso = new Date().toISOString();
      return send(req, res, 200, {
        session: { id: `sess-${u.id}`, token: `opaque-${u.id}`, userId: u.id, expiresAt: new Date(Date.now() + 86400000).toISOString(), createdAt: iso, updatedAt: iso },
        user: { id: u.id, email: u.email, name: u.name, image: null, emailVerified: true, createdAt: iso, updatedAt: iso },
        ...(path === '/auth/token' ? { token: jwt } : {}),
      }, { 'set-auth-jwt': jwt });
    }
    if (path === '/auth/sign-out') return send(req, res, 200, { success: true }, { 'set-cookie': 'e2e_user=; Path=/; Max-Age=0' });
    if (path.startsWith('/auth/sign-in/social')) return send(req, res, 200, { url: `${ISSUER}/auth/not-available`, redirect: true });
    send(req, res, 404, { message: `gateway: no route for ${req.method} ${path}` });
  } catch (e) {
    console.error(e);
    send(req, res, 500, { message: String(e) });
  }
}).listen(PORT, () => console.log(`gateway on ${PORT}`));
