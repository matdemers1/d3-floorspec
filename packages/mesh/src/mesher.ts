/**
 * The mesher: a document's derived geometry (chapters 5–7, 12, 15–17) as parts, each converted
 * once from base units to Float32 metres at the very end.
 */
import { deriveEvaluation, evaluate, type Derived, type FloorspecDocument, type ValidateOptions } from '@floorspec/engine';
import { extensionParts } from './extensions.js';
import { loadKernel, type Kernel, type KernelOptions } from './kernel.js';
import type { RawPart } from './part.js';
import { roofParts } from './roofs.js';
import { roomParts } from './rooms.js';
import { stairParts } from './stairs.js';
import { PART_KINDS, UNITS_PER_METRE, type Box3, type HouseMesh, type MeshOptions, type MeshPart, type PartKind, type PartStats, type Vec3 } from './types.js';
import { wallParts } from './walls.js';

export interface Mesher {
  /** Validate and derive a document, then mesh it. Throws the engine's InvalidDocumentError for an invalid one. */
  meshDocument(input: string | Uint8Array | object, options?: MeshOptions & { validate?: ValidateOptions }): HouseMesh;
  /** Mesh what the engine already derived from a valid document: a view that holds both derives once. */
  meshDerived(doc: FloorspecDocument, derived: Derived, options?: MeshOptions): HouseMesh;
}

/** Load manifold-3d (once) and return a mesher whose calls are synchronous. */
export async function loadMesher(options: KernelOptions = {}): Promise<Mesher> {
  const kernel = await loadKernel(options);
  return {
    meshDocument: (input, opts = {}) => {
      const ev = evaluate(input, opts.validate ?? {});
      const derived = deriveEvaluation(ev);
      return meshWith(kernel, ev.document!, derived, opts);
    },
    meshDerived: (doc, derived, opts = {}) => meshWith(kernel, doc, derived, opts),
  };
}

/** One-shot: load the mesher and mesh a document. */
export async function meshDocument(input: string | Uint8Array | object, options: MeshOptions & KernelOptions = {}): Promise<HouseMesh> {
  return (await loadMesher(options)).meshDocument(input, options);
}

const rank = new Map(PART_KINDS.map((k, i) => [k, i]));

function union(a: Box3 | null, b: Box3): Box3 {
  if (!a) return { min: [...b.min], max: [...b.max] };
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

function meshWith(kernel: Kernel, doc: FloorspecDocument, derived: Derived, options: MeshOptions): HouseMesh {
  const include = options.include ? new Set<PartKind>(options.include) : undefined;
  const want = (k: PartKind): boolean => !include || include.has(k);
  const levels = options.levels ? new Set(options.levels) : undefined;
  const origin: Vec3 = options.origin ? [...options.origin] : [0, 0, 0];

  const raw: RawPart[] = [];
  const free = (): void => {
    for (const r of raw) if ('manifold' in r) r.manifold.delete();
  };
  try {
    raw.push(
      ...wallParts(kernel, doc, derived, want),
      ...roomParts(kernel, doc, derived, want),
      ...roofParts(kernel, doc, derived, want),
      ...stairParts(kernel, doc, derived, want),
      ...extensionParts(kernel, derived, want),
    );
    const parts: MeshPart[] = [];
    for (const r of raw) {
      if (levels && !levels.has(r.level)) continue;
      const p = convert(r, origin, options.stats === true);
      if (p) parts.push(p);
    }
    parts.sort((a, b) => rank.get(a.kind)! - rank.get(b.kind)! || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    let bbox: Box3 | null = null;
    for (const p of parts) bbox = union(bbox, p.bbox);
    return { unitsPerMetre: UNITS_PER_METRE, origin, parts, bbox };
  } finally {
    free();
  }
}

/** A raw part as output: positions in metres relative to `origin`, as Float32 — the one conversion. */
function convert(r: RawPart, origin: Vec3, withStats: boolean): MeshPart | undefined {
  const { piece, ...meta } = r;
  const key = `${r.kind}:${r.id}${piece ? `:${piece}` : ''}`;
  const base = Object.fromEntries(Object.entries(meta).filter(([k]) => k !== 'exact' && k !== 'manifold' && k !== 'origin' && k !== 'box')) as Omit<MeshPart, 'key' | 'mesh' | 'bbox' | 'stats'>;
  if ('exact' in r) {
    const b = r.exact;
    const box = b.box();
    if (!box) return undefined;
    // Only the vertices a triangle uses, in the order they were first made.
    const used = new Int32Array(b.verts.length / 3).fill(-1);
    let n = 0;
    for (const i of b.tris) if (used[i] === -1) used[i] = n++;
    const positions = new Float32Array(3 * n);
    for (let i = 0; i < used.length; i++) {
      const j = used[i]!;
      if (j < 0) continue;
      for (let k = 0; k < 3; k++) positions[3 * j + k] = (b.verts[3 * i + k]! - origin[k]!) / UNITS_PER_METRE;
    }
    const indices = Uint32Array.from(b.tris, (i) => used[i]!);
    const part: MeshPart = { ...base, key, mesh: { positions, indices }, bbox: box };
    if (withStats) {
      const exact = r.closed && b.integral();
      const v6 = exact ? b.volume6() : 0n;
      const stats: PartStats = {
        volume: Number(v6) / 6,
        exactVolume: exact,
        ...(exact && { volume6: v6.toString() }),
        box: { min: [...box.min], max: [...box.max] },
      };
      part.stats = stats;
    }
    return part;
  }
  const m = r.manifold;
  if (m.isEmpty()) return undefined;
  const moved = m.translate(r.origin[0] - origin[0], r.origin[1] - origin[1], r.origin[2] - origin[2]);
  const scaled = moved.scale(1 / UNITS_PER_METRE);
  try {
    const mesh = scaled.getMesh();
    const np = mesh.numProp;
    const nv = mesh.vertProperties.length / np;
    const positions = new Float32Array(3 * nv);
    for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) positions[3 * i + k] = mesh.vertProperties[np * i + k]!;
    const part: MeshPart = { ...base, key, mesh: { positions, indices: new Uint32Array(mesh.triVerts) }, bbox: r.box };
    if (withStats) {
      const bb = m.boundingBox();
      part.stats = {
        volume: m.volume(),
        exactVolume: false,
        box: {
          min: [bb.min[0] + r.origin[0], bb.min[1] + r.origin[1], bb.min[2] + r.origin[2]],
          max: [bb.max[0] + r.origin[0], bb.max[1] + r.origin[1], bb.max[2] + r.origin[2]],
        },
        genus: m.genus(),
      };
    }
    return part;
  } finally {
    scaled.delete();
    moved.delete();
  }
}
