// Private file storage on Neon Object Storage (S3-compatible).
// The browser never receives storage credentials: every request is checked
// against the database (public.can_access_file) as the signed-in user, and
// only then gets a short-lived signed URL or a proxied stream.
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { type Caller, corsHeaders, HttpError, json } from './http.ts';

const RULES: Record<string, { types: RegExp; maxBytes: number }> = {
  documents: { types: /^application\/pdf$/, maxBytes: 100 * 1024 * 1024 },
  'question-images': { types: /^image\/(png|jpeg|webp|gif)$/, maxBytes: 5 * 1024 * 1024 },
};

/** Logical bucket name → actual Neon bucket (overridable per environment). */
function bucketName(logical: string): string {
  const env = logical === 'documents' ? process.env.BUCKET_DOCUMENTS : process.env.BUCKET_QUESTION_IMAGES;
  return env || logical;
}

let s3: S3Client | null = null;
function client(): S3Client {
  if (!process.env.AWS_ENDPOINT_URL_S3) throw new HttpError(500, 'Object storage is not configured on this branch.');
  s3 ??= new S3Client({
    region: process.env.AWS_REGION || 'auto',
    endpoint: process.env.AWS_ENDPOINT_URL_S3,
    forcePathStyle: true,
    // Presigned URLs must not carry SDK-computed checksums (they would be of an
    // empty body), and Neon implements a subset of S3 — only send checksums when required.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '' },
  });
  return s3;
}

function checkPath(bucket: unknown, path: unknown): { bucket: string; path: string } {
  if (typeof bucket !== 'string' || !RULES[bucket]) throw new HttpError(400, 'Unknown bucket.');
  if (typeof path !== 'string' || !/^[A-Za-z0-9._\-/]{1,300}$/.test(path) || path.includes('..') || path.startsWith('/')) {
    throw new HttpError(400, 'Invalid file path.');
  }
  return { bucket, path };
}

async function allowed(c: Caller, bucket: string, path: string, write: boolean): Promise<void> {
  const { data, error } = await c.db.rpc('can_access_file', { p_bucket: bucket, p_path: path, p_write: write });
  if (error) throw new HttpError(500, `Permission check failed: ${error.message}`);
  if (data !== true) throw new HttpError(403, write ? 'You can only upload or change your own files.' : 'You do not have access to this file.');
}

export async function handleFiles(req: Request, c: Caller, route: string): Promise<Response> {
  const url = new URL(req.url);

  if (route === '/files/sign-upload' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    const { bucket, path } = checkPath(body.bucket, body.path);
    const rule = RULES[bucket];
    const size = Number(body.size);
    if (typeof body.contentType !== 'string' || !rule.types.test(body.contentType)) throw new HttpError(400, 'This file type is not allowed here.');
    if (!Number.isInteger(size) || size <= 0 || size > rule.maxBytes) throw new HttpError(400, `Files must be at most ${rule.maxBytes / 1048576} MB.`);
    await allowed(c, bucket, path, true);
    const signed = await getSignedUrl(client(), new PutObjectCommand({
      Bucket: bucketName(bucket), Key: path, ContentType: body.contentType, ContentLength: size,
    }), { expiresIn: 300 });
    return json(req, { url: signed, method: 'PUT', headers: { 'Content-Type': body.contentType } });
  }

  if (route === '/files/sign-download' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    const { bucket, path } = checkPath(body.bucket, body.path);
    await allowed(c, bucket, path, false);
    const expiresIn = Math.min(Math.max(Number(body.expiresIn) || 600, 60), 3600);
    const signed = await getSignedUrl(client(), new GetObjectCommand({ Bucket: bucketName(bucket), Key: path }), { expiresIn });
    return json(req, { url: signed });
  }

  if (route === '/files/object') {
    const { bucket, path } = checkPath(url.searchParams.get('bucket'), url.searchParams.get('path'));
    if (req.method === 'GET') {
      await allowed(c, bucket, path, false);
      const obj = await client().send(new GetObjectCommand({ Bucket: bucketName(bucket), Key: path }))
        .catch(() => { throw new HttpError(404, 'File not found.'); });
      return new Response(obj.Body?.transformToWebStream() ?? null, {
        headers: { ...corsHeaders(req), 'Content-Type': obj.ContentType ?? 'application/octet-stream', 'Cache-Control': 'private, no-store' },
      });
    }
    if (req.method === 'PUT') {
      // fallback upload path when the browser cannot PUT to storage directly
      const rule = RULES[bucket];
      const type = req.headers.get('content-type') ?? '';
      if (!rule.types.test(type)) throw new HttpError(400, 'This file type is not allowed here.');
      await allowed(c, bucket, path, true);
      const buf = Buffer.from(await req.arrayBuffer());
      if (buf.length === 0 || buf.length > rule.maxBytes) throw new HttpError(400, `Files must be at most ${rule.maxBytes / 1048576} MB.`);
      await client().send(new PutObjectCommand({ Bucket: bucketName(bucket), Key: path, Body: buf, ContentType: type }));
      return json(req, { ok: true });
    }
    if (req.method === 'DELETE') {
      await allowed(c, bucket, path, true);
      await client().send(new DeleteObjectCommand({ Bucket: bucketName(bucket), Key: path }));
      return json(req, { ok: true });
    }
  }
  throw new HttpError(404, 'Unknown file route.');
}
