/**
 * FS_context in 3D (FS_context 6.1, FLR-T-15.3): the street, the neighbours and the trees beyond the lot
 * as `context` parts, in one neutral matte style (roles.ts CONTEXT_ROLES) that never takes a material of
 * the design. Every view that draws a meshed house draws them — the editor's 3D view, the headless
 * raster, both path tracers and the GPU still — so a neighbour's wall shades the terrace in each, unless
 * a view leaves context out (CONTEXT_CASTS_SHADE).
 *
 * - **a street**: its carriageway a surface at its elevation; its curbs, planting strips and sidewalks
 *   solids from the carriageway up by the curb's height (FS_context 2.1);
 * - **a neighbour**: its footprint extruded from its ground to its eaves (to its ridge, flat-roofed),
 *   and its gable or hip roof a solid over the eaves (3.2);
 * - **a tree**: a trunk, and a crown — a deciduous tree's a rounded mass, an evergreen's a cone.
 *
 * Drawn from the engine's `contextDrawing`, the same geometry the plan draws; coordinates rounded to base
 * units. Context is never the design: nothing here is counted.
 */
import { contextDrawing, type DrawContextTree, type DrawNeighbour, type DrawStreet, type FloorspecDocument } from '@floorspec/engine';
import { dedupe, MeshBuilder, type P2, type P3 } from './builder.js';
import type { Kernel } from './kernel.js';
import type { RawPart } from './part.js';
import type { ModelRole } from './roles.js';
import type { PartKind } from './types.js';

/**
 * Whether context casts shade on the design in a sun study, the daylight analysis and every render
 * (FS_context 6.2). The board decided yes; the owner may want a toggle later, and this is the one flag a
 * view reads to leave context out of its shadows.
 */
export const CONTEXT_CASTS_SHADE: boolean = true;

const R = (v: number): number => Math.round(v) + 0;
const ccw = (r: readonly P2[]): P2[] => {
  let a = 0;
  for (let i = 0; i < r.length; i++) a += r[i]![0] * r[(i + 1) % r.length]![1] - r[(i + 1) % r.length]![0] * r[i]![1];
  const pts = r.map((p): P2 => [R(p[0]), R(p[1])]);
  return a >= 0 ? pts : pts.reverse();
};

/** The level context is drawn on: the lowest by elevation, then by ID — as the plan draws it. */
export function contextLevel(doc: FloorspecDocument): string | undefined {
  const levels = Object.entries(doc.levels ?? {}) as [string, { elevation: number }][];
  levels.sort(([a, x], [b, y]) => x.elevation - y.elevation || (a < b ? -1 : a > b ? 1 : 0));
  return levels[0]?.[0];
}

type Piece = { piece: string; role: ModelRole; b: MeshBuilder; closed: boolean; facing?: 'up' };

function streetPieces(kernel: Kernel, s: DrawStreet): Piece[] {
  const out: Piece[] = [];
  const top = s.elevation + s.curbHeight;
  const pave = new MeshBuilder(kernel);
  pave.sheet([ccw(s.carriageway)], R(s.elevation), 'up');
  out.push({ piece: 'carriageway', role: 'contextPave', b: pave, closed: false, facing: 'up' });
  const solid = (name: string, role: ModelRole, rings: readonly (readonly (readonly [number, number])[])[]): void => {
    rings.forEach((r, i) => {
      if (s.curbHeight <= 0) return;
      const b = new MeshBuilder(kernel);
      b.prism([ccw(r)], R(s.elevation), R(top));
      out.push({ piece: `${name}:${String(i)}`, role, b, closed: true });
    });
  };
  solid('curb', 'contextCurb', s.curbs);
  solid('strip', 'contextVerge', s.strips);
  solid('sidewalk', 'contextWalk', s.sidewalks);
  return out;
}

function neighbourPieces(kernel: Kernel, n: DrawNeighbour): Piece[] {
  const ring = ccw(n.footprint);
  const flat = n.roof === 'flat' || n.ridgeLine === null;
  const body = new MeshBuilder(kernel);
  body.prism([ring], R(n.elevation), R(flat ? n.ridge : n.eaves));
  const out: Piece[] = [{ piece: 'massing', role: 'contextMass', b: body, closed: true }];
  if (!flat && n.ridge > n.eaves) {
    const roof = new MeshBuilder(kernel);
    const P = (p: readonly [number, number, number]): P3 => [R(p[0]), R(p[1]), R(p[2])];
    for (const plane of [...n.roofPlanes, ...n.gables]) {
      const face = dedupe(plane.map(P));
      if (face.length >= 3) roof.face([face]);
    }
    roof.sheet([ring], R(n.eaves), 'down');
    out.push({ piece: 'roof', role: 'contextRoof', b: roof, closed: true });
  }
  return out;
}

/** A regular polygon of `k` sides about a centre, counter-clockwise. */
const polygon = (cx: number, cy: number, r: number, k: number): P2[] => Array.from({ length: k }, (_, i) => [R(cx + r * Math.cos((2 * Math.PI * i) / k)), R(cy + r * Math.sin((2 * Math.PI * i) / k))] as P2);

function treePieces(kernel: Kernel, t: DrawContextTree): Piece[] {
  const [x, y] = t.at;
  const z0 = t.elevation;
  const rTrunk = Math.max(4 * 32_512, t.spread * 0.035);
  const crownFrom = z0 + t.height * (t.form === 'evergreen' ? 0.18 : 0.38);
  const trunk = new MeshBuilder(kernel);
  trunk.prism([polygon(x, y, rTrunk, 8)], R(z0), R(crownFrom + (t.height - (crownFrom - z0)) * 0.3));
  const crown = new MeshBuilder(kernel);
  const r = t.spread / 2;
  const k = 10;
  if (t.form === 'evergreen') {
    // a cone: its base at the crown's foot, its apex at the top
    const base = polygon(x, y, r, k);
    const apex: P3 = [R(x), R(y), R(z0 + t.height)];
    const zb = R(crownFrom);
    for (let i = 0; i < k; i++) crown.face([[[base[i]![0], base[i]![1], zb], [base[(i + 1) % k]![0], base[(i + 1) % k]![1], zb], apex]]);
    crown.sheet([base], zb, 'down');
  } else {
    // a rounded mass: rings of an ellipsoid from the crown's foot to its top
    const zc = (crownFrom + z0 + t.height) / 2;
    const rz = (z0 + t.height - crownFrom) / 2;
    const bands = 5;
    const rings: P3[][] = [];
    for (let j = 1; j < bands; j++) {
      const phi = -Math.PI / 2 + (Math.PI * j) / bands;
      const rr = r * Math.cos(phi);
      const zz = R(zc + rz * Math.sin(phi));
      rings.push(polygon(x, y, rr, k).map((p): P3 => [p[0], p[1], zz]));
    }
    const bottom: P3 = [R(x), R(y), R(zc - rz)];
    const top: P3 = [R(x), R(y), R(zc + rz)];
    for (let i = 0; i < k; i++) {
      const i1 = (i + 1) % k;
      crown.face([[bottom, rings[0]![i1]!, rings[0]![i]!]]);
      for (let j = 0; j + 1 < rings.length; j++) crown.quad(rings[j]![i]!, rings[j]![i1]!, rings[j + 1]![i1]!, rings[j + 1]![i]!);
      crown.face([[rings[rings.length - 1]![i]!, rings[rings.length - 1]![i1]!, top]]);
    }
  }
  return [
    { piece: 'trunk', role: 'contextTrunk', b: trunk, closed: true },
    { piece: 'crown', role: t.form === 'evergreen' ? 'contextConifer' : 'contextCrown', b: crown, closed: true },
  ];
}

/** Every record of FS_context as parts of kind `context`, on the lowest level. */
export function contextParts(kernel: Kernel, doc: FloorspecDocument, want: (kind: PartKind) => boolean): RawPart[] {
  if (!want('context')) return [];
  const level = contextLevel(doc);
  if (level === undefined) return [];
  const ctx = contextDrawing(doc);
  if (ctx.empty) return [];
  const out: RawPart[] = [];
  const push = (id: string, collection: string, kind: string, pieces: Piece[]): void => {
    for (const p of pieces)
      out.push({ kind: 'context', id, level, piece: p.piece, closed: p.closed, ...(p.facing ? { facing: p.facing } : {}), extension: { name: 'FS_context', collection }, model: { kind, role: p.role }, exact: p.b });
  };
  for (const s of ctx.streets) push(s.id, 'streets', 'street', streetPieces(kernel, s));
  for (const n of ctx.neighbours) push(n.id, 'neighbours', 'neighbour', neighbourPieces(kernel, n));
  for (const t of ctx.trees) push(t.id, 'trees', t.form === 'evergreen' ? 'evergreen' : 'tree', treePieces(kernel, t));
  return out;
}
