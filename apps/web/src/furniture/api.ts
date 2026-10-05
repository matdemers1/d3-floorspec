import { ApiError } from '../lib/api';
import { assetUrl } from '../lib/assets';
import type { StoredFile } from './ops';

/**
 * The asset route (FLR-T-8.2) as furniture uses it (FLR-T-8.3): a model is uploaded `?as=model`
 * and a plan symbol `?as=symbol`; the server reads what each is from its bytes, refuses what it is
 * not, sanitizes an SVG, and answers the asset entry the document should carry.
 */

export type Purpose = 'model' | 'symbol';

/** The files the upload dialog's pickers take. */
export const MODEL_ACCEPT = '.glb,.gltf,model/gltf-binary,model/gltf+json';
export const SYMBOL_ACCEPT = '.svg,.png,image/svg+xml,image/png';

export interface Uploaded extends StoredFile {
  href: string;
  stripped: string[];
}

export async function uploadAsset(projectId: string, file: Blob, name: string, as: Purpose): Promise<Uploaded> {
  const headers = new Headers({ 'content-type': 'application/octet-stream', 'x-asset-name': encodeURIComponent(name) });
  const res = await fetch(`/api/projects/${projectId}/assets?as=${as}`, { method: 'POST', headers, body: file, credentials: 'same-origin' });
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
  const b = body as { asset: StoredFile & { href: string }; stripped?: string[] };
  return { ...b.asset, stripped: b.stripped ?? [] };
}

/** A library file's bytes, from where the editor serves it. */
export async function libraryBytes(url: string): Promise<Blob> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`the library file could not be read (${String(res.status)})`);
  return res.blob();
}

/**
 * Where the bytes of a file this store may read are: the project's asset route, or in the shared
 * viewer (a `share:<token>` store) the link's own (FLR-T-9.6) — so a link's plan symbols and
 * models load with no account instead of falling back to outlines and boxes.
 */
export const assetHref = assetUrl;
