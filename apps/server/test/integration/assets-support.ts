import type { Browser, Reply } from './helpers.js';

/**
 * Uploads for the asset suites (FLR-T-8.2): the raw bytes as the body, as the editor sends them —
 * which the JSON-speaking `Browser.request` cannot. Carries the browser's cookies, or its bearer
 * token when it is given one.
 */
export async function upload(
  base: string,
  as: Browser | { bearer: string },
  projectId: string,
  bytes: Uint8Array,
  options: { name?: string; contentType?: string } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { 'content-type': options.contentType ?? 'application/octet-stream' };
  if ('bearer' in as) headers['authorization'] = `Bearer ${as.bearer}`;
  else if (as.cookies.size > 0) headers['cookie'] = [...as.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  if (options.name !== undefined) headers['x-asset-name'] = encodeURIComponent(options.name);
  const res = await fetch(`${base}/api/projects/${projectId}/assets`, { method: 'POST', headers, body: Buffer.from(bytes), redirect: 'manual' });
  const text = await res.text();
  let body: unknown;
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  return { status: res.status, body, text, headers: res.headers };
}

/** GET with the browser's cookies, keeping the body as bytes. */
export async function fetchBytes(base: string, as: Browser, path: string, headers: Record<string, string> = {}): Promise<{ status: number; bytes: Uint8Array; headers: Headers }> {
  const cookie = [...as.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(`${base}${path}`, { headers: { ...(cookie === '' ? {} : { cookie }), ...headers }, redirect: 'manual' });
  return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()), headers: res.headers };
}

export interface UploadedAsset {
  sha256: string;
  mediaType: string;
  byteLength: number;
  width: number;
  height: number;
  name: string | null;
  path: string;
  href: string;
}
