// Neon Function `api` (Node.js 24).
//   POST /ai                 { action: "status" | "plan" | "generate", ... }  — admin only
//   POST /files/sign-upload  { bucket, path, contentType, size }              — admin only
//   POST /files/sign-download{ bucket, path }                                 — per can_access_file
//   GET|PUT|DELETE /files/object?bucket=&path=                                — per can_access_file
// Every request must carry the caller's Neon Auth JWT. The AI key is read
// from the AI_API_KEY environment variable and never leaves the server.
import { generate, loadSettings, plan } from './ai.ts';
import { handleFiles } from './files.ts';
import { authenticate, corsHeaders, HttpError, isAdmin, json } from './http.ts';
import type { GenerationRequest } from '../_shared/types.ts';

export async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) });
  try {
    const route = new URL(req.url).pathname.replace(/\/+$/, '') || '/';
    if (route === '/' || route === '/health') return json(req, { ok: true, service: 'jee-portal-api' });
    if (Number(req.headers.get('content-length') ?? 0) > 110 * 1024 * 1024) throw new HttpError(413, 'Request too large.');

    const caller = await authenticate(req);

    if (route.startsWith('/files/')) return await handleFiles(req, caller, route);

    if (route === '/ai' && req.method === 'POST') {
      if (!(await isAdmin(caller))) throw new HttpError(403, 'Administrator access required.');
      const body = await req.json().catch(() => ({}));
      switch (body?.action) {
        case 'status': {
          const settings = await loadSettings(caller.db);
          return json(req, { provider: settings.provider, model: settings.model, has_key: !!process.env.AI_API_KEY });
        }
        case 'plan':
          if (!body.request || typeof body.request !== 'object') throw new HttpError(400, 'Missing exam requirements.');
          return json(req, await plan(caller.db, caller.userId, body.request as GenerationRequest));
        case 'generate':
          if (typeof body.job_id !== 'string') throw new HttpError(400, 'Missing job_id.');
          return json(req, await generate(caller.db, caller.userId, body.job_id));
        default:
          throw new HttpError(400, 'Unknown action.');
      }
    }
    throw new HttpError(404, 'Not found.');
  } catch (e) {
    if (e instanceof HttpError) return json(req, { error: e.message, details: e.details ?? null }, e.status);
    console.error('api failure', e);
    return json(req, { error: 'Unexpected server error. See the function logs.' }, 500);
  }
}

export default { fetch: handle };
