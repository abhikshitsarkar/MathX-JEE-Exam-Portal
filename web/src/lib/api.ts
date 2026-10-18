import { accessToken, API_URL, db } from './db';

/** Turns database/API errors into messages a person can act on. */
export function friendlyError(err: unknown): string {
  const e = err as { message?: string; code?: string; details?: string } | null;
  const msg = e?.message ?? String(err ?? 'Something went wrong');
  if (/JWT|session|token|Authentication required/i.test(msg) && !/rate/i.test(msg)) return 'Your session has expired. Sign in again.';
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return 'Could not reach the server. Check your connection and try again.';
  if (e?.code === '23505') return 'This item already exists.';
  if (e?.code === '23503') return 'This item is still used elsewhere and cannot be removed.';
  return msg.replace(/^(ERROR:\s*)/, '');
}

export async function rpc<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args ?? {});
  if (error) throw new Error(friendlyError(error));
  return data as T;
}

// ------------------------------------------------------------ server function
async function call(path: string, init: RequestInit = {}): Promise<Response> {
  if (!API_URL) throw new Error('The server function URL (VITE_API_URL) is not configured.');
  const token = await accessToken();
  if (!token) throw new Error('Your session has expired. Sign in again.');
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { ...init, headers });
  } catch {
    throw new Error('Could not reach the server. Check your connection and try again.');
  }
  if (!res.ok) {
    const payload = await res.clone().json().catch(() => null);
    const e = new Error(payload?.error ?? `The server returned an error (${res.status}).`) as Error & { details?: string[]; status?: number };
    e.details = payload?.details?.errors;
    e.status = res.status;
    throw e;
  }
  return res;
}

export async function invokeAi<T = unknown>(body: Record<string, unknown>): Promise<T> {
  const res = await call('/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return (await res.json()) as T;
}

// ------------------------------------------------------------ private files
export type Bucket = 'documents' | 'question-images';
const q = (bucket: Bucket, path: string) => `?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(path)}`;

/** Short-lived link for an image tag or download; null when not allowed. */
export async function signedUrl(bucket: Bucket, path: string, seconds = 600): Promise<string | null> {
  try {
    const res = await call('/files/sign-download', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bucket, path, expiresIn: seconds }),
    });
    return ((await res.json()) as { url: string }).url;
  } catch {
    return null;
  }
}

/** Uploads straight to storage with a signed URL; falls back to the server if the browser cannot. */
export async function uploadFile(bucket: Bucket, path: string, file: Blob, onProgress?: (msg: string) => void): Promise<void> {
  const type = file.type || (bucket === 'documents' ? 'application/pdf' : 'application/octet-stream');
  const res = await call('/files/sign-upload', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bucket, path, contentType: type, size: file.size }),
  });
  const signed = (await res.json()) as { url: string; method: string; headers: Record<string, string> };
  try {
    const put = await fetch(signed.url, { method: signed.method, headers: signed.headers, body: file });
    if (put.ok) return;
    throw new Error(`storage returned ${put.status}`);
  } catch {
    onProgress?.('Uploading through the server…');
    await call(`/files/object${q(bucket, path)}`, { method: 'PUT', headers: { 'Content-Type': type }, body: file });
  }
}

export async function downloadFile(bucket: Bucket, path: string): Promise<ArrayBuffer> {
  const res = await call(`/files/object${q(bucket, path)}`);
  return res.arrayBuffer();
}

export async function deleteFile(bucket: Bucket, path: string): Promise<void> {
  await call(`/files/object${q(bucket, path)}`, { method: 'DELETE' });
}
