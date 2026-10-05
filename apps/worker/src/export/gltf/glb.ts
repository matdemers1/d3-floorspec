/**
 * glTF 2.0 binary (.glb) from a scene (FLR-T-9.2, FLR-REQ-127): +Y up, metres, a node per element
 * named by its Floorspec ID and name with `extras.floorspec` = { id, kind, level }, under a node per
 * level under one node for the model. PBR metallic-roughness materials from the document's own
 * (Core 18.1 is glTF's model, so nothing is converted but sRGB to linear): `color` is the base
 * colour factor, `metallic` and `roughness` in thousandths the factors.
 *
 * A material's maps are embedded when their bytes are given (`images`) and are PNG or JPEG — the
 * image types core glTF holds; WebP and KTX2 would need an extension, and are left out and said so.
 * A material whose base colour map is embedded has a white base colour factor, so the texel is the
 * colour (18.1). Without the bytes, the material is its `color`, and the summary says which maps
 * were left out.
 *
 * An extension element's fallback model (Core 12.6) is merged in at its placement when its glTF
 * binary is given (`models`), its meshes shared by every element that names it (merge.ts); without
 * it, the element keeps its fallback box and a marker node where the model goes.
 *
 * Deterministic: the same scene writes the same bytes — no dates, no random IDs, keys in one order.
 */
import type { Scene, SceneMaterial } from './scene.js';
import { mergeModel, type MergedModel } from './merge.js';

/** The bytes of an asset a material's map names, when the exporter can have them. */
export type ImageSource = (asset: { id: string; sha256: string; mediaType: string }) => Uint8Array | undefined;

export interface GlbOptions {
  /** The generator string in `asset.generator`. */
  readonly generator?: string;
  /** More of `asset.extras.floorspec`: the version, what was exported. */
  readonly about?: Record<string, unknown>;
  readonly images?: ImageSource;
  /** The bytes of the glTF binaries extension elements' fallbacks name (Core 12.6), when the exporter can have them. */
  readonly models?: ImageSource;
}

/** What became of the fallback models: merged, by asset ID, and those left out as markers, and why. */
export interface ModelsReport {
  readonly merged: string[];
  readonly omitted: { asset: string; reason: string }[];
}

export interface GlbResult {
  readonly bytes: Uint8Array;
  readonly nodes: number;
  readonly meshes: number;
  readonly materials: number;
  readonly triangles: number;
  /** Maps embedded, by asset ID. */
  readonly embedded: string[];
  /** Maps left out, and why. */
  readonly omitted: { asset: string; reason: string }[];
  readonly models: ModelsReport;
}

const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const REPEAT = 10497;
const LINEAR = 9729;
const LINEAR_MIPMAP_LINEAR = 9987;
const EMBEDDABLE = new Set(['image/png', 'image/jpeg']);

type Json = Record<string, unknown>;

/** Rounded to what a float32 holds, so the JSON carries no false precision. */
const f = (x: number): number => Math.fround(x);

class Bin {
  private readonly chunks: Uint8Array[] = [];
  length = 0;
  readonly views: Json[] = [];

  view(bytes: Uint8Array, target?: number, extra: Json = {}): number {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad > 0) {
      this.chunks.push(new Uint8Array(pad));
      this.length += pad;
    }
    this.views.push({ buffer: 0, byteOffset: this.length, byteLength: bytes.byteLength, ...extra, ...(target === undefined ? {} : { target }) });
    this.chunks.push(bytes);
    this.length += bytes.byteLength;
    return this.views.length - 1;
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.length + ((4 - (this.length % 4)) % 4));
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
  }
}

const asBytes = (a: Float32Array | Uint16Array | Uint32Array): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

function minMax(a: Float32Array, n: number): { min: number[]; max: number[] } {
  const min = new Array<number>(n).fill(Infinity);
  const max = new Array<number>(n).fill(-Infinity);
  for (let i = 0; i < a.length; i += n)
    for (let k = 0; k < n; k++) {
      const v = a[i + k]!;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
  return { min, max };
}

/** Write a scene as a .glb. */
export function writeGlb(scene: Scene, options: GlbOptions = {}): GlbResult {
  const bin = new Bin();
  const accessors: Json[] = [];
  const images: Json[] = [];
  const textures: Json[] = [];
  const samplers: Json[] = [];
  /** The maps' one sampler, written when the first map is. */
  let mapSampler: number | undefined;
  const imageOf = new Map<string, number>();
  const embedded: string[] = [];
  const omitted: { asset: string; reason: string }[] = [];

  /** The texture index of an asset's image, embedding it once; undefined when it cannot be. */
  const texture = (asset: string): number | undefined => {
    const at = imageOf.get(asset);
    if (at !== undefined) return at;
    const info = scene.assets[asset];
    if (info === undefined) return undefined;
    if (!EMBEDDABLE.has(info.mediaType)) {
      omitted.push({ asset, reason: `${info.mediaType} needs a glTF extension this export does not write` });
      return undefined;
    }
    const bytes = options.images?.({ id: asset, sha256: info.sha256, mediaType: info.mediaType });
    if (bytes === undefined) {
      omitted.push({ asset, reason: 'its bytes were not available to the exporter' });
      return undefined;
    }
    images.push({ name: asset, bufferView: bin.view(bytes), mimeType: info.mediaType });
    mapSampler ??= samplers.push({ magFilter: LINEAR, minFilter: LINEAR_MIPMAP_LINEAR, wrapS: REPEAT, wrapT: REPEAT }) - 1;
    textures.push({ sampler: mapSampler, source: images.length - 1 });
    imageOf.set(asset, textures.length - 1);
    embedded.push(asset);
    return textures.length - 1;
  };

  const materials = scene.materials.map((m) => materialJson(m, texture));
  // A normal map needs a tangent space: written, not left to each viewer to generate.
  const normalMapped = new Set(materials.flatMap((m, i) => (m['normalTexture'] === undefined ? [] : [i])));

  const meshes: Json[] = [];
  const nodes: Json[] = [];
  let triangles = 0;

  // Fallback models (Core 12.6): each glTF binary read and copied in once, by asset ID.
  const extensionsUsed = new Set<string>();
  const target = { view: (bytes: Uint8Array, extra?: Json) => bin.view(bytes, undefined, extra), accessors, meshes, materials, textures, images, samplers, nodes, extensionsUsed };
  const mergedOf = new Map<string, MergedModel | null>();
  const models: ModelsReport = { merged: [], omitted: [] };
  const modelFor = (asset: string, sha256: string | undefined, mediaType: string | undefined): MergedModel | null => {
    if (mergedOf.has(asset)) return mergedOf.get(asset) ?? null;
    let merged: MergedModel | null = null;
    if (mediaType !== 'model/gltf-binary' || sha256 === undefined) models.omitted.push({ asset, reason: `${mediaType ?? 'a model with no media type'} is not a glTF binary this export merges` });
    else {
      const bytes = options.models?.({ id: asset, sha256, mediaType });
      if (bytes === undefined) models.omitted.push({ asset, reason: 'its bytes were not available to the exporter' });
      else {
        const made = mergeModel(target, bytes);
        if (typeof made === 'function') {
          merged = made;
          models.merged.push(asset);
        } else models.omitted.push({ asset, reason: made.reason });
      }
    }
    mergedOf.set(asset, merged);
    return merged;
  };
  nodes.push({}); // the model's node, filled in below
  const levelNodes: number[] = [];
  for (let i = 0; i < scene.levels.length; i++) {
    nodes.push({});
    levelNodes.push(nodes.length - 1);
  }
  scene.levels.forEach((level, li) => {
    const children: number[] = [];
    for (const node of level.nodes) {
      let mesh: number | undefined;
      if (node.primitives.length > 0) {
        const primitives = node.primitives.map((p) => {
          const n = p.positions.length / 3;
          const position = accessors.push({ bufferView: bin.view(asBytes(p.positions), ARRAY_BUFFER), componentType: FLOAT, count: n, type: 'VEC3', ...minMax(p.positions, 3) }) - 1;
          const normal = accessors.push({ bufferView: bin.view(asBytes(p.normals), ARRAY_BUFFER), componentType: FLOAT, count: n, type: 'VEC3' }) - 1;
          const uv = p.uvs === null ? undefined : accessors.push({ bufferView: bin.view(asBytes(p.uvs), ARRAY_BUFFER), componentType: FLOAT, count: n, type: 'VEC2' }) - 1;
          const tangent =
            p.uvs === null || !normalMapped.has(p.material)
              ? undefined
              : accessors.push({ bufferView: bin.view(asBytes(tangents(p.positions, p.normals, p.uvs, p.indices)), ARRAY_BUFFER), componentType: FLOAT, count: n, type: 'VEC4' }) - 1;
          const short = n <= 65535;
          const idx = short ? Uint16Array.from(p.indices) : p.indices;
          const indices =
            accessors.push({ bufferView: bin.view(asBytes(idx), ELEMENT_ARRAY_BUFFER), componentType: short ? UNSIGNED_SHORT : UNSIGNED_INT, count: p.indices.length, type: 'SCALAR' }) - 1;
          triangles += p.indices.length / 3;
          return { attributes: { POSITION: position, NORMAL: normal, ...(tangent === undefined ? {} : { TANGENT: tangent }), ...(uv === undefined ? {} : { TEXCOORD_0: uv }) }, indices, material: p.material, mode: 4 };
        });
        mesh = meshes.push({ name: node.id, primitives }) - 1;
      }
      const floorspec: Json = { id: node.id, kind: node.kind, level: node.level, parts: node.parts };
      if (node.category !== undefined) floorspec['category'] = node.category;
      if (node.extension !== undefined) floorspec['extension'] = node.extension.name;
      if (node.extension !== undefined) floorspec['collection'] = node.extension.collection;
      const element: Json = { name: node.name === undefined ? node.id : `${node.id} ${node.name}`, ...(mesh === undefined ? {} : { mesh }), extras: { floorspec } };
      nodes.push(element);
      const at = nodes.length - 1;
      children.push(at);
      if (node.model !== undefined) {
        // Core 12.6: the fallback model's origin, turned by the element's facing alone. The model
        // itself is the asset's; this export marks where it goes.
        const marker: Json = {
          name: `${node.id} model`,
          translation: node.model.translation.map(f),
          rotation: node.model.rotation.map(f),
          extras: { floorspec: { id: node.id, model: node.model.asset } },
        };
        nodes.push(marker);
        element['children'] = [nodes.length - 1];
        // The model's own scene under the marker: its frame is the export's (metres, +Y up, +X the front).
        const merged = modelFor(node.model.asset, node.model.sha256, node.model.mediaType);
        if (merged !== null) marker['children'] = merged(node.id);
      }
    }
    nodes[levelNodes[li]!] = { name: level.name === undefined ? level.id : `${level.id} ${level.name}`, children, extras: { floorspec: { id: level.id, kind: 'level', elevation: f(level.elevation) } } };
  });
  nodes[0] = { name: scene.project, ...(levelNodes.length === 0 ? {} : { children: levelNodes }), extras: { floorspec: { kind: 'model' } } };

  const json: Json = {
    asset: {
      version: '2.0',
      generator: options.generator ?? 'D3 Floorspec',
      extras: { floorspec: { ...options.about, design: scene.design, upAxis: 'Y', unit: 'metre' } },
    },
    ...(extensionsUsed.size === 0 ? {} : { extensionsUsed: [...extensionsUsed].sort() }),
    scene: 0,
    scenes: [{ name: scene.project, nodes: [0] }],
    nodes,
    ...(meshes.length === 0 ? {} : { meshes }),
    ...(materials.length === 0 ? {} : { materials }),
    ...(textures.length === 0 ? {} : { textures }),
    ...(images.length === 0 ? {} : { images }),
    ...(samplers.length === 0 ? {} : { samplers }),
    ...(accessors.length === 0 ? {} : { accessors, bufferViews: bin.views }),
    ...(bin.length === 0 ? {} : { buffers: [{ byteLength: bin.bytes().byteLength }] }),
  };
  const bytes = glbOf(json, bin.length === 0 ? null : bin.bytes());
  return { bytes, nodes: nodes.length, meshes: meshes.length, materials: materials.length, triangles, embedded, omitted, models };
}

/**
 * Tangents for a normal map, per Core 18.2: the map's +X runs towards increasing s′ (u), its +Y
 * towards increasing t′ — up the image, so against glTF's v. Faces are flat and mapped linearly, so
 * a triangle's tangent is its plane's; `w` makes cross(normal, tangent) · w point up the tile.
 */
function tangents(P: Float32Array, N: Float32Array, UV: Float32Array, I: Uint32Array): Float32Array {
  const out = new Float32Array((P.length / 3) * 4);
  for (let t = 0; t < I.length; t += 3) {
    const [a, b, c] = [I[t]!, I[t + 1]!, I[t + 2]!];
    const e1 = [P[3 * b]! - P[3 * a]!, P[3 * b + 1]! - P[3 * a + 1]!, P[3 * b + 2]! - P[3 * a + 2]!];
    const e2 = [P[3 * c]! - P[3 * a]!, P[3 * c + 1]! - P[3 * a + 1]!, P[3 * c + 2]! - P[3 * a + 2]!];
    const du1 = UV[2 * b]! - UV[2 * a]!;
    const dv1 = UV[2 * b + 1]! - UV[2 * a + 1]!;
    const du2 = UV[2 * c]! - UV[2 * a]!;
    const dv2 = UV[2 * c + 1]! - UV[2 * a + 1]!;
    const det = du1 * dv2 - du2 * dv1;
    const n = [N[3 * a]!, N[3 * a + 1]!, N[3 * a + 2]!];
    let T = [0, 1, 2].map((k) => (e1[k]! * dv2 - e2[k]! * dv1) / (det || 1));
    const up = [0, 1, 2].map((k) => -(e2[k]! * du1 - e1[k]! * du2) / (det || 1)); // increasing t′
    const nt = n[0]! * T[0]! + n[1]! * T[1]! + n[2]! * T[2]!;
    T = T.map((x, k) => x - n[k]! * nt);
    let len = Math.hypot(T[0]!, T[1]!, T[2]!);
    if (det === 0 || len < 1e-12) {
      // No mapping across this face: any direction in its plane.
      T = Math.abs(n[1]!) < 0.9 ? [n[2]!, 0, -n[0]!] : [1, 0, 0];
      const d = n[0]! * T[0]! + n[1]! * T[1]! + n[2]! * T[2]!;
      T = T.map((x, k) => x - n[k]! * d);
      len = Math.hypot(T[0]!, T[1]!, T[2]!);
    }
    T = T.map((x) => x / len);
    const B = [n[1]! * T[2]! - n[2]! * T[1]!, n[2]! * T[0]! - n[0]! * T[2]!, n[0]! * T[1]! - n[1]! * T[0]!];
    const w = B[0]! * up[0]! + B[1]! * up[1]! + B[2]! * up[2]! < 0 ? -1 : 1;
    for (const v of [a, b, c]) out.set([T[0]!, T[1]!, T[2]!, w], 4 * v);
  }
  return out;
}

function materialJson(m: SceneMaterial, texture: (asset: string) => number | undefined): Json {
  const maps = m.texture?.maps ?? {};
  const base = maps.asset === undefined ? undefined : texture(maps.asset);
  const mr = maps.metallicRoughness === undefined ? undefined : texture(maps.metallicRoughness);
  const normal = maps.normal === undefined ? undefined : texture(maps.normal);
  const occlusion = maps.occlusion === undefined ? undefined : texture(maps.occlusion);
  // 18.1: with a metallic-roughness map, an absent factor lets the map through (1); without, the defaults.
  const metallic = mr === undefined ? m.metallic : (m.declared.metallic ?? 1000) / 1000;
  const roughness = mr === undefined ? m.roughness : (m.declared.roughness ?? 1000) / 1000;
  const pbr: Json = {
    baseColorFactor: (base === undefined ? m.baseColor : [1, 1, 1, m.baseColor[3]]).map(f),
    metallicFactor: f(metallic),
    roughnessFactor: f(roughness),
    ...(base === undefined ? {} : { baseColorTexture: { index: base } }),
    ...(mr === undefined ? {} : { metallicRoughnessTexture: { index: mr } }),
  };
  return {
    name: m.name,
    pbrMetallicRoughness: pbr,
    ...(normal === undefined ? {} : { normalTexture: { index: normal } }),
    ...(occlusion === undefined ? {} : { occlusionTexture: { index: occlusion } }),
    ...(m.blend ? { alphaMode: 'BLEND', doubleSided: true } : {}),
    extras: { floorspec: m.floorspec === undefined ? { default: m.key.slice('default:'.length) } : { id: m.floorspec, ...(m.color === undefined ? {} : { color: m.color }) } },
  };
}

/** The GLB container: a 12-byte header, the JSON chunk padded with spaces, the BIN chunk with zeros. */
function glbOf(json: Json, bin: Uint8Array | null): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = text.byteLength + ((4 - (text.byteLength % 4)) % 4);
  const total = 12 + 8 + jsonLength + (bin === null ? 0 : 8 + bin.byteLength);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true); // glTF
  v.setUint32(4, 2, true);
  v.setUint32(8, total, true);
  v.setUint32(12, jsonLength, true);
  v.setUint32(16, 0x4e4f534a, true); // JSON
  out.set(text, 20);
  out.fill(0x20, 20 + text.byteLength, 20 + jsonLength);
  if (bin !== null) {
    const at = 20 + jsonLength;
    v.setUint32(at, bin.byteLength, true);
    v.setUint32(at + 4, 0x004e4942, true); // BIN
    out.set(bin, at + 8);
  }
  return out;
}

/** Read a .glb's JSON and BIN chunks back (tests, and the render of an exported file). */
export function readGlb(bytes: Uint8Array): { json: Json; bin: Uint8Array | null } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || v.getUint32(0, true) !== 0x46546c67 || v.getUint32(4, true) !== 2) throw new Error('not a glTF 2.0 binary');
  const jsonLength = v.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as Json;
  const at = 20 + jsonLength;
  const bin = at + 8 <= bytes.byteLength ? bytes.subarray(at + 8, at + 8 + v.getUint32(at, true)) : null;
  return { json, bin };
}
