import { ApiError } from '../lib/api';
import type { UploadedAsset } from './calibrate';

/**
 * The asset routes (FLR-T-8.2) as the editor uses them. An upload is the file's own bytes as the
 * body — not JSON, not a form — with its name in `X-Asset-Name`; the server reads what it is from
 * the bytes, removes its metadata and answers the asset entry the document should carry.
 */

/** The formats a texture's map may be (Core 18.2.2), for the file picker. */
export const ACCEPT = 'image/png,image/jpeg,image/webp,.ktx2,image/ktx2';

export async function uploadTexture(projectId: string, file: Blob & { name?: string }): Promise<UploadedAsset> {
  const headers = new Headers({ 'content-type': file.type === '' ? 'application/octet-stream' : file.type });
  if (file.name !== undefined && file.name !== '') headers.set('x-asset-name', encodeURIComponent(file.name));
  const res = await fetch(`/api/projects/${projectId}/assets`, { method: 'POST', headers, body: file, credentials: 'same-origin' });
  const text = await res.text();
  let body: unknown;
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body ? String(body.error) : `the upload failed with ${String(res.status)}`;
    throw new ApiError(res.status, message, body);
  }
  return (body as { asset: UploadedAsset }).asset;
}

/** Where the bytes of a file this project may read are. */
export const assetHref = (projectId: string, sha256: string): string => `/api/projects/${projectId}/assets/${sha256}`;

type Json = Record<string, unknown>;

/** The document's asset entry for `id` as an uploaded asset, when it is a packaged image: what calibrating an existing texture starts from. */
export function documentAsset(projectId: string, assets: Record<string, Json | undefined> | undefined, id: string, size?: { width: number; height: number }): UploadedAsset | null {
  const a = assets?.[id];
  const sha256 = a?.['sha256'];
  const path = a?.['path'];
  if (typeof sha256 !== 'string' || typeof path !== 'string') return null;
  return {
    sha256,
    mediaType: typeof a?.['mediaType'] === 'string' ? a['mediaType'] : 'application/octet-stream',
    byteLength: typeof a?.['byteLength'] === 'number' ? a['byteLength'] : 0,
    width: size?.width ?? 0,
    height: size?.height ?? 0,
    name: typeof a?.['name'] === 'string' ? a['name'] : null,
    path,
    href: assetHref(projectId, sha256),
  };
}
