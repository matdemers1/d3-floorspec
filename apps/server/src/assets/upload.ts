import { EXTENSIONS, MediaError, prepareImage, sniff } from './media.js';
import { ModelError, prepareModel } from './gltf.js';
import { looksLikeSvg, sanitizeSvg, SvgError } from './svg.js';

/**
 * What an upload is for, and what each purpose accepts (FLR-T-8.2, FLR-T-8.3). The asset route
 * takes `?as=`; without it an upload is a texture, as it always was, so a model or an SVG never
 * reaches a texture picker by accident.
 *
 *   texture  a texture map (Core 18.2.2): PNG, JPEG, WebP, KTX2 — metadata stripped (media.ts)
 *   model    a fallback model (Core 12.6): glTF 2.0, .glb or self-contained .gltf (gltf.ts)
 *   symbol   a fallback plan symbol (Core 12.6): SVG, sanitized (svg.ts), or PNG, stripped
 */
export type Purpose = 'texture' | 'model' | 'symbol';

export const PURPOSES: readonly Purpose[] = ['texture', 'model', 'symbol'];

/** The file extension of every media type the store keeps: the package path's (Core 18.4). */
export const ASSET_EXTENSIONS: Readonly<Record<string, string>> = {
  ...EXTENSIONS,
  'model/gltf-binary': 'glb',
  'model/gltf+json': 'gltf',
  'image/svg+xml': 'svg',
};

export interface PreparedUpload {
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  /** An image's pixels or an SVG's drawing size; 0 for a model. */
  readonly width: number;
  readonly height: number;
  /** What was removed: metadata chunks, or an SVG's disallowed elements and attributes. */
  readonly stripped: readonly string[];
}

/** Identify, check and clean an upload for a purpose; MediaError (415, 422) when it is not one. */
export function prepareUpload(b: Uint8Array, purpose: Purpose): PreparedUpload {
  try {
    switch (purpose) {
      case 'texture':
        return prepareImage(b);
      case 'model': {
        const m = prepareModel(b);
        return { mediaType: m.mediaType, bytes: m.bytes, width: 0, height: 0, stripped: [] };
      }
      case 'symbol': {
        if (sniff(b) === 'image/png') return prepareImage(b);
        if (!looksLikeSvg(b)) throw new MediaError('a plan symbol must be an SVG or a PNG image', 415);
        const s = sanitizeSvg(b);
        return { mediaType: 'image/svg+xml', bytes: s.bytes, width: s.width, height: s.height, stripped: s.removed };
      }
    }
  } catch (error) {
    if (error instanceof ModelError) throw new MediaError(error.message, error.status);
    if (error instanceof SvgError) throw new MediaError(error.message, 422);
    throw error;
  }
}

/** `?as=`: a purpose, or texture when absent; null when it names none. */
export function purposeOf(query: unknown): Purpose | null {
  if (query === undefined) return 'texture';
  return typeof query === 'string' && (PURPOSES as readonly string[]).includes(query) ? (query as Purpose) : null;
}
