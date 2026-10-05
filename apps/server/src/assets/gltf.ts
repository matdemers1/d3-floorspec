/**
 * glTF 2.0 models (FLR-T-8.3, Core 12.6, FS_furniture 3.2): what an uploaded model is, read from its
 * bytes. A binary glTF (`model/gltf-binary`, `.glb`) is its 12-byte header — `glTF`, version 2, its
 * length — and a JSON chunk; a JSON glTF (`model/gltf+json`, `.gltf`) is that JSON on its own. Either
 * way the JSON must say `asset.version` 2.x.
 *
 * A model travels in a package (Core 18.4) as one file, and a reader never fetches anything (Core
 * 18.4, FS_furniture 3.4) — so a model must be self-contained: every buffer and image is inside it
 * (the GLB's binary chunk, a buffer view, or a `data:` URI). A model that names another file is
 * refused with a reason, not stored to fail later. Nothing in a model is rewritten: unlike a photo
 * it carries no camera or location, and its bytes are what its digest names.
 */

export type ModelMediaType = 'model/gltf-binary' | 'model/gltf+json';

export class ModelError extends Error {
  constructor(
    message: string,
    readonly status: 415 | 422,
  ) {
    super(message);
    this.name = 'ModelError';
  }
}

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'

const u32 = (b: Uint8Array, at: number): number => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at, true);

/** Whether bytes are a binary glTF, by their magic. */
export const isGlb = (b: Uint8Array): boolean => b.length >= 12 && u32(b, 0) === GLB_MAGIC;

/** Whether bytes look like a JSON glTF: a JSON object whose text mentions `"asset"`, before parsing. */
export function looksLikeGltfJson(b: Uint8Array): boolean {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(b.subarray(0, 64)).replace(/^\uFEFF/, '').trimStart();
  return head.startsWith('{') && new TextDecoder('utf-8', { fatal: false }).decode(b.subarray(0, Math.min(b.length, 1 << 20))).includes('"asset"');
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseJson(text: string): Json {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new ModelError('this glTF’s JSON cannot be read', 422);
  }
  if (!isObject(v)) throw new ModelError('this glTF’s JSON is not an object', 422);
  return v;
}

/** The JSON chunk of a GLB, checked against its header. */
function glbJson(b: Uint8Array): Json {
  if (b.length < 20) throw new ModelError('this GLB is cut short', 422);
  const version = u32(b, 4);
  if (version !== 2) throw new ModelError(`this is a glTF ${String(version)} binary; a model must be glTF 2.0`, 422);
  const length = u32(b, 8);
  if (length !== b.length) throw new ModelError('this GLB is cut short or has bytes after its end', 422);
  const chunkLength = u32(b, 12);
  if (u32(b, 16) !== CHUNK_JSON) throw new ModelError('this GLB’s first chunk is not its JSON', 422);
  if (20 + chunkLength > b.length) throw new ModelError('this GLB is cut short', 422);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(20, 20 + chunkLength));
  } catch {
    throw new ModelError('this GLB’s JSON is not UTF-8', 422);
  }
  return parseJson(text);
}

/** Every buffer and image is inside the file: the GLB's own chunk (no uri), a buffer view, or a data: URI. */
function selfContained(json: Json, binary: boolean): void {
  const outside = (list: unknown, what: string) => {
    if (!Array.isArray(list)) return;
    list.forEach((item, i) => {
      if (!isObject(item)) return;
      const uri = item['uri'];
      if (uri === undefined) {
        // A GLB's first buffer is its binary chunk; an image may be in a buffer view.
        if (what === 'buffer' && !binary) throw new ModelError(`buffer ${String(i)} of this .gltf has no data: export the model as a .glb, or with its buffers embedded`, 422);
        return;
      }
      if (typeof uri !== 'string' || !/^data:/i.test(uri))
        throw new ModelError(`${what} ${String(i)} of this model is another file (${typeof uri === 'string' ? uri.slice(0, 80) : '?'}): a model must be one self-contained file — export it as a .glb`, 422);
    });
  };
  outside(json['buffers'], 'buffer');
  outside(json['images'], 'image');
}

export interface PreparedModel {
  readonly mediaType: ModelMediaType;
  readonly bytes: Uint8Array;
}

/** Identify and check an uploaded model; ModelError when it is not a self-contained glTF 2.0 model. */
export function prepareModel(b: Uint8Array): PreparedModel {
  let json: Json;
  let mediaType: ModelMediaType;
  if (isGlb(b)) {
    json = glbJson(b);
    mediaType = 'model/gltf-binary';
  } else if (looksLikeGltfJson(b)) {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(b);
    } catch {
      throw new ModelError('this .gltf is not UTF-8 text', 422);
    }
    json = parseJson(text.replace(/^\uFEFF/, ''));
    mediaType = 'model/gltf+json';
  } else {
    throw new ModelError('a model must be a glTF 2.0 file: .glb or .gltf', 415);
  }
  const asset = json['asset'];
  const version = isObject(asset) ? asset['version'] : undefined;
  if (typeof version !== 'string' || !/^2\.\d+$/.test(version)) throw new ModelError('a model must be glTF 2.0: its asset.version must be 2.x', 422);
  const required = json['extensionsRequired'];
  if (Array.isArray(required) && required.length > 0)
    throw new ModelError(`this model requires glTF extensions (${required.map(String).join(', ')}) that a reader may not have: export it without them`, 422);
  selfContained(json, mediaType === 'model/gltf-binary');
  return { mediaType, bytes: b };
}
