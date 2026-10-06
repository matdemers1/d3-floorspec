/**
 * Headless 3D render-back (FLR-T-8.5, FLR-REQ-122): a PNG of a version's 3D model from a named view
 * — `sw`, `se`, `ne`, `nw` (isometric corners) or `top` — or from inside a room, drawn by the worker
 * from the same scene the glTF and USDZ exports write (export/gltf/scene.ts), by a software
 * rasterizer (raster.ts). An agent asks for it through MCP `floorspec_render` with `view: "3d"`; the
 * api queues it on the job queue and waits for the worker.
 */
import { buildScene, readGlb, type Scene, type SceneOptions, type Vec3 } from '../export/gltf/index.js';
import { linear } from '../export/gltf/scene.js';
import { findRoom, PRESETS, presetCamera, roomCamera, type Camera, type Preset } from './camera.js';
import { encodePng } from './png.js';
import { rasterize, type DrawList } from './raster.js';

export { PRESETS, presetCamera, roomCamera, findRoom, centroid, type Camera, type Preset } from './camera.js';
export { rasterize, type DrawList, type RasterOptions } from './raster.js';
export { encodePng } from './png.js';

export const DEFAULT_WIDTH = 1024;
export const MAX_WIDTH = 2048;

export interface Render3dOptions extends Omit<SceneOptions, 'levels'> {
  /** A named view. Default `sw` — unless `room` is given. */
  readonly camera?: Preset;
  /** Stand in this room (its ID or name) instead. */
  readonly room?: string;
  /** Cut away above this level: its ceilings and roof are left off, and every level above it. */
  readonly level?: string;
  /** Element IDs drawn in the accent colour. */
  readonly highlight?: readonly string[];
  /** Pixels; the height is three quarters of it. Default 1024. */
  readonly width?: number;
}

export interface Render3dResult {
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** What the camera was, in words. */
  readonly camera: string;
  readonly design: Record<string, string> | null;
}

/** The accent a highlighted element is drawn in (linear RGB). */
const ACCENT = linear('#3d63dd');
const GROUND = linear('#dedbd2');

interface Tri {
  readonly a: Vec3;
  readonly b: Vec3;
  readonly c: Vec3;
  readonly rgb: readonly [number, number, number];
  readonly alpha: number;
  readonly twoSided: boolean;
  readonly key?: number;
  readonly bias?: number;
}

/** Triangles into a draw list, each keyed by its plane, so coplanar neighbours draw no line. */
function drawList(tris: readonly Tri[]): DrawList {
  const n = tris.length;
  const list = {
    positions: new Float32Array(9 * n),
    normals: new Float32Array(3 * n),
    colors: new Float32Array(3 * n),
    alpha: new Float32Array(n),
    keys: new Int32Array(n),
    twoSided: new Uint8Array(n),
    bias: new Uint8Array(n),
    count: n,
  };
  const planes = new Map<string, number>();
  let kept = 0;
  for (const t of tris) {
    const u = [t.b[0] - t.a[0], t.b[1] - t.a[1], t.b[2] - t.a[2]];
    const v = [t.c[0] - t.a[0], t.c[1] - t.a[1], t.c[2] - t.a[2]];
    const nx = u[1]! * v[2]! - u[2]! * v[1]!;
    const ny = u[2]! * v[0]! - u[0]! * v[2]!;
    const nz = u[0]! * v[1]! - u[1]! * v[0]!;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) continue;
    const nrm: Vec3 = [nx / l, ny / l, nz / l];
    const d = nrm[0] * t.a[0] + nrm[1] * t.a[1] + nrm[2] * t.a[2];
    const plane = `${String(Math.round(nrm[0] * 50))},${String(Math.round(nrm[1] * 50))},${String(Math.round(nrm[2] * 50))},${String(Math.round(d * 200))}`;
    let key = t.key;
    if (key === undefined) {
      key = planes.get(plane);
      if (key === undefined) {
        key = planes.size;
        planes.set(plane, key);
      }
    }
    list.positions.set([...t.a, ...t.b, ...t.c], 9 * kept);
    list.normals.set(nrm, 3 * kept);
    list.colors.set(t.rgb, 3 * kept);
    list.alpha[kept] = t.alpha;
    list.keys[kept] = key;
    list.twoSided[kept] = t.twoSided ? 1 : 0;
    list.bias[kept] = t.bias ?? 0;
    kept++;
  }
  return { ...list, count: kept };
}

const mix = (c: readonly [number, number, number], d: readonly [number, number, number], k: number): [number, number, number] => [
  c[0] + (d[0] - c[0]) * k,
  c[1] + (d[1] - c[1]) * k,
  c[2] + (d[2] - c[2]) * k,
];

/** A big ground plate under the house, out to the horizon. */
function ground(bounds: { min: Vec3; max: Vec3 }): Tri[] {
  const cx = (bounds.min[0] + bounds.max[0]) / 2;
  const cz = (bounds.min[2] + bounds.max[2]) / 2;
  const r = 40 * Math.max(5, Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[2] - bounds.min[2]));
  const y = bounds.min[1] - 0.003;
  const p: Vec3[] = [
    [cx - r, y, cz + r],
    [cx + r, y, cz + r],
    [cx + r, y, cz - r],
    [cx - r, y, cz - r],
  ];
  return [
    { a: p[0]!, b: p[1]!, c: p[2]!, rgb: GROUND, alpha: 1, twoSided: false, key: -2 },
    { a: p[0]!, b: p[2]!, c: p[3]!, rgb: GROUND, alpha: 1, twoSided: false, key: -2 },
  ];
}

/** The scene's triangles as drawn: cut away above `level`, highlighted, with a ground under them. */
export function sceneTriangles(scene: Scene, options: { level?: string; highlight?: readonly string[]; ground?: boolean } = {}): Tri[] {
  const order = new Map(scene.levels.map((l, i) => [l.id, i]));
  const cut = options.level === undefined ? undefined : order.get(options.level);
  const lit = new Set(options.highlight ?? []);
  const tris: Tri[] = [];
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const level of scene.levels) {
    const at = order.get(level.id)!;
    if (cut !== undefined && at > cut) continue;
    for (const node of level.nodes)
      for (const p of node.primitives) {
        if (cut === at && (p.part === 'ceiling' || p.part === 'roof' || p.part === 'roofGable')) continue;
        const m = scene.materials[p.material]!;
        const rgb = lit.has(node.id) ? mix(m.baseColor.slice(0, 3) as Vec3, ACCENT, 0.6) : (m.baseColor.slice(0, 3) as Vec3);
        const bias = p.part === 'ceiling' ? 2 : p.part === 'floor' ? 1 : 0;
        const P = p.positions;
        const at3 = (i: number): Vec3 => [P[3 * i]!, P[3 * i + 1]!, P[3 * i + 2]!];
        for (let k = 0; k < p.indices.length; k += 3) {
          const a = at3(p.indices[k]!);
          const b = at3(p.indices[k + 1]!);
          const c = at3(p.indices[k + 2]!);
          for (const q of [a, b, c])
            for (let j = 0; j < 3; j++) {
              min[j] = Math.min(min[j]!, q[j]!);
              max[j] = Math.max(max[j]!, q[j]!);
            }
          tris.push({ a, b, c, rgb, alpha: m.baseColor[3], twoSided: m.blend, bias });
        }
      }
  }
  if (options.ground !== false && Number.isFinite(min[0])) tris.push(...ground({ min, max }));
  return tris;
}

function boundsOf(tris: readonly Tri[]): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) {
    if (t.key === -2) continue;
    for (const q of [t.a, t.b, t.c])
      for (let j = 0; j < 3; j++) {
        min[j] = Math.min(min[j]!, q[j]!);
        max[j] = Math.max(max[j]!, q[j]!);
      }
  }
  return Number.isFinite(min[0]) ? { min, max } : { min: [0, 0, 0], max: [0, 0, 0] };
}

function sizeOf(width: number | undefined): { width: number; height: number } {
  const w = width ?? DEFAULT_WIDTH;
  if (!Number.isInteger(w) || w < 64 || w > MAX_WIDTH) throw new RangeError(`width is an integer from 64 to ${String(MAX_WIDTH)}`);
  return { width: w, height: Math.round((w * 3) / 4) };
}

/** Render a scene: from a named view, or from inside a room. */
export function renderScene(scene: Scene, options: Omit<Render3dOptions, 'design'> = {}): Render3dResult {
  const { width, height } = sizeOf(options.width);
  if (options.level !== undefined && !scene.levels.some((l) => l.id === options.level)) throw new RangeError(`the model has no level ${options.level} with anything to draw`);
  let camera: Camera;
  let tris: Tri[];
  if (options.room !== undefined) {
    const room = findRoom(scene.rooms, options.room);
    if (room === undefined) {
      const known = scene.rooms.map((r) => (r.name === undefined ? r.id : `${r.id} (${r.name})`));
      throw new RangeError(`the model has no room ${options.room}${known.length === 0 ? '' : `; its rooms are ${known.slice(0, 20).join(', ')}`}`);
    }
    camera = roomCamera(room, scene.doors);
    tris = sceneTriangles(scene, { ...(options.highlight === undefined ? {} : { highlight: options.highlight }), ground: true });
  } else {
    tris = sceneTriangles(scene, {
      ...(options.level === undefined ? {} : { level: options.level }),
      ...(options.highlight === undefined ? {} : { highlight: options.highlight }),
    });
    camera = presetCamera(options.camera ?? 'sw', boundsOf(tris), width / height);
  }
  const rgb = rasterize(drawList(tris), camera, { width, height, supersample: 2 });
  return { png: encodePng(rgb, width, height), width, height, camera: camera.label, design: scene.design };
}

export interface ViewOptions {
  readonly camera?: Preset;
  /** Cut away above this level (as `renderScene`). */
  readonly level?: string;
  /** Pixels, any aspect: a drawing sheet's 3D panel is the panel's shape. */
  readonly width: number;
  readonly height: number;
  /** Linear RGB behind the model. Default white: a drawing's paper. */
  readonly background?: Vec3;
  /** A ground plate under the house. Default false. */
  readonly ground?: boolean;
}

/**
 * A named view of a scene at any size, for a drawing (FLR-T-9.7): the model alone on the paper's
 * colour, framed on what is drawn. Null when nothing is drawn (an empty model, or a cut below it).
 */
export function renderView(scene: Scene, options: ViewOptions): { png: Uint8Array; width: number; height: number; camera: string } | null {
  const { width, height } = options;
  for (const v of [width, height]) if (!Number.isInteger(v) || v < 16 || v > MAX_WIDTH) throw new RangeError(`a view is 16 to ${String(MAX_WIDTH)} pixels each way`);
  const tris = sceneTriangles(scene, { ...(options.level === undefined ? {} : { level: options.level }), ground: options.ground ?? false });
  if (tris.every((t) => t.key === -2)) return null;
  const camera = presetCamera(options.camera ?? 'sw', boundsOf(tris), width / height);
  const bg = options.background ?? [1, 1, 1];
  const rgb = rasterize(drawList(tris), camera, { width, height, supersample: 2, sky: [bg, bg] });
  return { png: encodePng(rgb, width, height), width, height, camera: camera.label };
}

/** Render a version's 3D model (FLR-T-8.5). Throws for an invalid model, an unknown room or level. */
export async function render3dPng(document: object, options: Render3dOptions = {}): Promise<Render3dResult> {
  if (options.camera !== undefined && !PRESETS.includes(options.camera)) throw new RangeError(`camera is one of ${PRESETS.join(', ')}`);
  // One evaluation, with the reader asked for (default OFFICIAL_READER, the editor's: FLR-T-12.10).
  const scene = await buildScene(document, { ...(options.design === undefined ? {} : { design: options.design }), ...(options.reader === undefined ? {} : { reader: options.reader }) });
  return renderScene(scene, options);
}

// ─── An exported .glb, drawn back ────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;
type Mat4 = number[];

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r]! += a[k * 4 + r]! * b[c * 4 + k]!;
  return o;
}
function trs(node: Json): Mat4 {
  if (Array.isArray(node['matrix'])) return node['matrix'] as Mat4;
  const [tx, ty, tz] = (node['translation'] as number[] | undefined) ?? [0, 0, 0];
  const [x, y, z, w] = (node['rotation'] as number[] | undefined) ?? [0, 0, 0, 1];
  const [sx, sy, sz] = (node['scale'] as number[] | undefined) ?? [1, 1, 1];
  const r = [1 - 2 * (y! * y! + z! * z!), 2 * (x! * y! + z! * w!), 2 * (x! * z! - y! * w!), 2 * (x! * y! - z! * w!), 1 - 2 * (x! * x! + z! * z!), 2 * (y! * z! + x! * w!), 2 * (x! * z! + y! * w!), 2 * (y! * z! - x! * w!), 1 - 2 * (x! * x! + y! * y!)];
  return [r[0]! * sx!, r[1]! * sx!, r[2]! * sx!, 0, r[3]! * sy!, r[4]! * sy!, r[5]! * sy!, 0, r[6]! * sz!, r[7]! * sz!, r[8]! * sz!, 0, tx!, ty!, tz!, 1];
}

/**
 * The triangles of a .glb this exporter wrote (float positions, 16- or 32-bit indices, no strides),
 * in its base colours: what a viewer that opens the file shows, drawn by the same rasterizer.
 */
export function glbTriangles(bytes: Uint8Array, options: { highlight?: readonly string[] } = {}): Tri[] {
  const { json, bin } = readGlb(bytes);
  if (bin === null) return [];
  const accessors = (json['accessors'] ?? []) as Json[];
  const views = (json['bufferViews'] ?? []) as Json[];
  const meshes = (json['meshes'] ?? []) as Json[];
  const materials = (json['materials'] ?? []) as Json[];
  const nodes = (json['nodes'] ?? []) as Json[];
  const lit = new Set(options.highlight ?? []);
  const read = (index: number): Float32Array | Uint16Array | Uint32Array => {
    const a = accessors[index]!;
    const view = views[a['bufferView'] as number]!;
    const offset = bin.byteOffset + Number(view['byteOffset'] ?? 0) + Number(a['byteOffset'] ?? 0);
    const width = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a['type'] as string] ?? 1;
    const count = Number(a['count']) * width;
    const copy = bin.buffer.slice(offset, offset + count * (a['componentType'] === 5123 ? 2 : 4));
    return a['componentType'] === 5126 ? new Float32Array(copy) : a['componentType'] === 5123 ? new Uint16Array(copy) : new Uint32Array(copy);
  };
  const tris: Tri[] = [];
  const walk = (index: number, parent: Mat4, id: string | undefined): void => {
    const node = nodes[index]!;
    const m = mul(parent, trs(node));
    const own = ((node['extras'] as Json | undefined)?.['floorspec'] as Json | undefined)?.['id'];
    const element = typeof own === 'string' ? own : id;
    if (typeof node['mesh'] === 'number')
      for (const p of (meshes[node['mesh']]!['primitives'] as Json[] | undefined) ?? []) {
        const attrs = p['attributes'] as Record<string, number>;
        const pos = read(attrs['POSITION']!);
        const idx = typeof p['indices'] === 'number' ? read(p['indices']) : Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
        const mat = typeof p['material'] === 'number' ? materials[p['material']] : undefined;
        const pbr = (mat?.['pbrMetallicRoughness'] ?? {}) as Json;
        const factor = (pbr['baseColorFactor'] as number[] | undefined) ?? [1, 1, 1, 1];
        const base: [number, number, number] = [factor[0]!, factor[1]!, factor[2]!];
        const rgb = element !== undefined && lit.has(element) ? mix(base, ACCENT, 0.6) : base;
        const blend = mat?.['alphaMode'] === 'BLEND';
        const at = (i: number): Vec3 => {
          const x = pos[3 * i]!;
          const y = pos[3 * i + 1]!;
          const z = pos[3 * i + 2]!;
          return [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!];
        };
        for (let k = 0; k + 2 < idx.length; k += 3)
          tris.push({ a: at(idx[k]!), b: at(idx[k + 1]!), c: at(idx[k + 2]!), rgb, alpha: blend ? factor[3]! : 1, twoSided: mat?.['doubleSided'] === true });
      }
    for (const child of (node['children'] as number[] | undefined) ?? []) walk(child, m, element);
  };
  const scene = ((json['scenes'] as Json[] | undefined) ?? [])[Number(json['scene'] ?? 0)];
  for (const root of (scene?.['nodes'] as number[] | undefined) ?? []) walk(root, IDENTITY, undefined);
  return tris;
}

/** Draw an exported .glb from a named view, with a ground under it. */
export function renderGlb(bytes: Uint8Array, options: { camera?: Preset; width?: number; highlight?: readonly string[] } = {}): Render3dResult {
  const { width, height } = sizeOf(options.width);
  const tris = glbTriangles(bytes, options.highlight === undefined ? {} : { highlight: options.highlight });
  const box = boundsOf(tris);
  tris.push(...ground(box));
  const camera = presetCamera(options.camera ?? 'sw', box, width / height);
  const rgb = rasterize(drawList(tris), camera, { width, height, supersample: 2 });
  return { png: encodePng(rgb, width, height), width, height, camera: camera.label, design: null };
}
