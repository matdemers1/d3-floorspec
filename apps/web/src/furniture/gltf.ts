/**
 * An uploaded model's box (FLR-T-8.3, FS_furniture 3.1, 3.2; Core 12.6): the bounds of a glTF 2.0
 * model's default scene, read from its accessors — every POSITION accessor carries its `min` and
 * `max` (glTF 2.0 §5.1.1) — through each node's transform, then placed in the element's frame by
 * Core 12.6's mapping, so the element's box is the space the model is drawn in.
 *
 * Core 12.6 places a fallback model with its +X the element's front, +Y up and −Z its left: the
 * model point (X, Y, Z) is the local point (1,280,000·X, −1,280,000·Z, 1,280,000·Y). A model made
 * facing glTF's suggested +Z is used under a node turned +90° about +Y (Core 12.6's note), which
 * takes (X, Y, Z) to (Z, Y, −X) first — the "faces +Z" toggle.
 *
 * Pure — no three.js, no DOM — so it is tested on its own and the box is computed the same way
 * wherever it is asked for.
 */

export type Vec3 = [number, number, number];
export interface Bounds {
  min: Vec3;
  max: Vec3;
}
export interface Box {
  min: [number, number, number];
  max: [number, number, number];
}

export class GltfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GltfError';
  }
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The JSON of a .glb or .gltf file. */
export function gltfJson(bytes: Uint8Array): Json {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let text: string;
  if (bytes.length >= 20 && view.getUint32(0, true) === 0x46546c67) {
    if (view.getUint32(4, true) !== 2) throw new GltfError('this is not a glTF 2.0 binary');
    const length = view.getUint32(12, true);
    if (view.getUint32(16, true) !== 0x4e4f534a || 20 + length > bytes.length) throw new GltfError('this GLB is damaged');
    text = new TextDecoder().decode(bytes.subarray(20, 20 + length));
  } else {
    text = new TextDecoder().decode(bytes).replace(/^\uFEFF/, '');
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new GltfError('this model’s JSON cannot be read');
  }
  if (!isObject(json)) throw new GltfError('this model’s JSON is not an object');
  return json;
}

type Mat4 = number[];
const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Column-major product a·b, as glTF stores matrices. */
function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] = (out[c * 4 + r] ?? 0) + (a[k * 4 + r] ?? 0) * (b[c * 4 + k] ?? 0);
  return out;
}

const nums = (v: unknown, n: number): number[] | null => (Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? (v as number[]) : null);

/** A node's local matrix: its `matrix`, or translation · rotation · scale. */
function localMatrix(node: Json): Mat4 {
  const m = nums(node['matrix'], 16);
  if (m !== null) return m;
  const [tx = 0, ty = 0, tz = 0] = nums(node['translation'], 3) ?? [];
  const [qx = 0, qy = 0, qz = 0, qw = 1] = nums(node['rotation'], 4) ?? [];
  const [sx = 1, sy = 1, sz = 1] = nums(node['scale'], 3) ?? [];
  const xx = qx * qx, yy = qy * qy, zz = qz * qz, xy = qx * qy, xz = qx * qz, yz = qy * qz, wx = qw * qx, wy = qw * qy, wz = qw * qz;
  return [
    (1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
    2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
    2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function apply(m: Mat4, p: Vec3): Vec3 {
  const [x, y, z] = p;
  return [
    (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0),
    (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0),
    (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0),
  ];
}

/**
 * The bounds of a model's default scene (or its first), in glTF metres: each mesh's POSITION
 * accessors' boxes, their corners carried through the node's world transform. Exact for transforms
 * that keep the axes; for a turned node, the box around the turned box. GltfError when there is no
 * geometry to bound.
 */
export function gltfBounds(json: Json): Bounds {
  const nodes = Array.isArray(json['nodes']) ? (json['nodes'] as unknown[]) : [];
  const meshes = Array.isArray(json['meshes']) ? (json['meshes'] as unknown[]) : [];
  const accessors = Array.isArray(json['accessors']) ? (json['accessors'] as unknown[]) : [];
  const scenes = Array.isArray(json['scenes']) ? (json['scenes'] as unknown[]) : [];
  const sceneIndex = typeof json['scene'] === 'number' ? json['scene'] : 0;
  const scene = scenes[sceneIndex];
  const roots: number[] = isObject(scene) && Array.isArray(scene['nodes']) ? (scene['nodes'] as unknown[]).filter((n): n is number => typeof n === 'number') : nodes.map((_, i) => i);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const seen = new Set<number>();
  const visit = (index: number, parent: Mat4, depth: number) => {
    if (depth > 64 || seen.has(index)) return;
    seen.add(index);
    const node = nodes[index];
    if (!isObject(node)) return;
    const world = multiply(parent, localMatrix(node));
    const mesh = typeof node['mesh'] === 'number' ? meshes[node['mesh']] : undefined;
    const primitives = isObject(mesh) && Array.isArray(mesh['primitives']) ? (mesh['primitives'] as unknown[]) : [];
    for (const prim of primitives) {
      const attrs = isObject(prim) ? prim['attributes'] : undefined;
      const pos = isObject(attrs) ? attrs['POSITION'] : undefined;
      const acc = typeof pos === 'number' ? accessors[pos] : undefined;
      const lo = isObject(acc) ? nums(acc['min'], 3) : null;
      const hi = isObject(acc) ? nums(acc['max'], 3) : null;
      if (lo === null || hi === null) continue;
      for (let c = 0; c < 8; c++) {
        const corner = apply(world, [c & 1 ? hi[0] ?? 0 : lo[0] ?? 0, c & 2 ? hi[1] ?? 0 : lo[1] ?? 0, c & 4 ? hi[2] ?? 0 : lo[2] ?? 0]);
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k] as number, corner[k] as number);
          max[k] = Math.max(max[k] as number, corner[k] as number);
        }
      }
    }
    const children = Array.isArray(node['children']) ? (node['children'] as unknown[]) : [];
    for (const child of children) if (typeof child === 'number') visit(child, world, depth + 1);
  };
  for (const r of roots) visit(r, IDENTITY, 0);
  if (!min.every(Number.isFinite)) throw new GltfError('this model has no geometry with bounds (POSITION accessors with min and max)');
  return { min, max };
}

/** The base units in a metre (FLR-ADR-004). */
export const UNITS_PER_METRE = 1_280_000;
/** A box's least extent (Core 13.2.2): 1 mm. */
const MIN_EXTENT = 1_280;

/**
 * The element's box for a model's bounds (Core 12.6): each glTF point taken into the element's
 * frame — turned first when the model faces +Z — then rounded outwards to whole base units, every
 * extent at least 1 mm.
 */
export function boxFromBounds(b: Bounds, facesPlusZ = false): Box {
  // (X, Y, Z) → local (p, q, r): faces +X: (X, −Z, Y); faces +Z: (Z, X, Y) — turned (Z, Y, −X), then mapped.
  const corners: Vec3[] = [];
  for (let c = 0; c < 8; c++) {
    const X = c & 1 ? b.max[0] : b.min[0];
    const Y = c & 2 ? b.max[1] : b.min[1];
    const Z = c & 4 ? b.max[2] : b.min[2];
    corners.push(facesPlusZ ? [Z, X, Y] : [X, -Z, Y]);
  }
  const axis = (k: number): [number, number] => {
    const lo = Math.min(...corners.map((p) => p[k] as number)) * UNITS_PER_METRE;
    const hi = Math.max(...corners.map((p) => p[k] as number)) * UNITS_PER_METRE;
    // Rounded outwards — but an accessor's float32 noise (0.30000001 m is 384,000.015 units) is
    // within a unit of the length meant, and that length is taken.
    const near = (v: number) => Math.abs(v - Math.round(v)) < 1;
    const a = near(lo) ? Math.round(lo) : Math.floor(lo);
    const b = near(hi) ? Math.round(hi) : Math.ceil(hi);
    // `+ 0` makes a negative zero an integer zero.
    return [a + 0, (b - a < MIN_EXTENT ? a + MIN_EXTENT : b) + 0];
  };
  const [x, y, z] = [axis(0), axis(1), axis(2)];
  return { min: [x[0], y[0], z[0]], max: [x[1], y[1], z[1]] };
}

/** A model file's box, straight from its bytes. */
export function modelBox(bytes: Uint8Array, facesPlusZ = false): Box {
  return boxFromBounds(gltfBounds(gltfJson(bytes)), facesPlusZ);
}

/** Width, depth and height of a box (FS_furniture 3.1): its extents along y, x and z. */
export function dimensions(box: Box): { width: number; depth: number; height: number } {
  return { width: box.max[1] - box.min[1], depth: box.max[0] - box.min[0], height: box.max[2] - box.min[2] };
}

/**
 * A model made facing glTF's +Z, turned to face +X as Core 12.6's note says: its scene put under one
 * new node rotated +90° about +Y — the quaternion [0, √½, 0, √½] — and nothing else changed. The
 * buffers are untouched (a GLB's binary chunk is copied as it is), so only the JSON is new.
 */
export function faceXFromZ(bytes: Uint8Array): Uint8Array {
  const json = gltfJson(bytes);
  const nodes = Array.isArray(json['nodes']) ? [...(json['nodes'] as unknown[])] : [];
  const scenes = Array.isArray(json['scenes']) ? [...(json['scenes'] as unknown[])] : [{ nodes: nodes.map((_, i) => i) }];
  const index = typeof json['scene'] === 'number' ? json['scene'] : 0;
  const scene: Json = isObject(scenes[index]) ? { ...scenes[index] } : { nodes: [] };
  const turned = nodes.length;
  nodes.push({ name: 'Floorspec: faces +X (Core 12.6)', rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2], children: Array.isArray(scene['nodes']) ? scene['nodes'] : [] });
  scene['nodes'] = [turned];
  scenes[index] = scene;
  const next = { ...json, nodes, scenes, scene: index };
  const text = new TextEncoder().encode(JSON.stringify(next));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!(bytes.length >= 20 && view.getUint32(0, true) === 0x46546c67)) return text;
  // A GLB: the new JSON chunk, padded with spaces to four bytes, then every other chunk as it was.
  const padded = new Uint8Array(Math.ceil(text.length / 4) * 4).fill(0x20);
  padded.set(text);
  const rest = bytes.subarray(20 + view.getUint32(12, true));
  const out = new Uint8Array(12 + 8 + padded.length + rest.length);
  const o = new DataView(out.buffer);
  o.setUint32(0, 0x46546c67, true);
  o.setUint32(4, 2, true);
  o.setUint32(8, out.length, true);
  o.setUint32(12, padded.length, true);
  o.setUint32(16, 0x4e4f534a, true);
  out.set(padded, 20);
  out.set(rest, 20 + padded.length);
  return out;
}

/**
 * A plan symbol for a model uploaded without one: its footprint's outline with a line along its
 * front, drawn as FS_furniture 3.3 says — `viewBox` `0 0 w d` in millimetres, the front along the
 * bottom edge. Every kind requires a symbol (FS_furniture 2, Core 12.4.2), so a reader without the
 * extension still draws the item as something.
 */
export function outlineSymbol(box: Box, title: string): string {
  const w = Math.max(1, Math.round((box.max[1] - box.min[1]) / 1_280));
  const d = Math.max(1, Math.round((box.max[0] - box.min[0]) / 1_280));
  const s = Math.max(2, Math.round(Math.min(w, d) / 60));
  const esc = title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(w)} ${String(d)}" width="${String(w)}mm" height="${String(d)}mm">`,
    `<title>${esc}</title>`,
    // The symbol's own drawing, black on white as the library's are (FS_furniture 7): not chrome.
    `<rect x="${String(s / 2)}" y="${String(s / 2)}" width="${String(w - s)}" height="${String(d - s)}" fill="white" stroke="black" stroke-width="${String(s)}"/>`,
    `<line x1="0" y1="${String(d - 3 * s)}" x2="${String(w)}" y2="${String(d - 3 * s)}" stroke="black" stroke-width="${String(s / 2)}"/>`,
    '</svg>',
  ].join('\n');
}
