/**
 * FS_energy for drawing (registry/FS_energy/spec.md, informative): what the editor, render2d, the 3D
 * mesh, the worker and @floorspec/analysis draw and measure from a document's solar arrays — every roof
 * face a module could lie on with its tilt, its bearing and its edges classed eave, ridge or rake (4.2)
 * with the setback each keeps; and every array with its modules, each a quad in 3D on its face or on
 * its rack.
 *
 * Floating point is fine here: nothing drawn is normative. An array's footprint and whether it is clear
 * of its setbacks are the exact ones FS_energy derives (energy.ts); only the modules inside it are
 * worked out in floats.
 */
import { facingVector } from '../../exact/angle.js';
import { entries, get, type FloorspecDocument } from '../../model/document.js';
import { deriveRoofs, type DerivedRoof } from '../../roofs/roofs.js';
import {
  arrayFootprint,
  cornerClear,
  edgeKind,
  energyCollection,
  facePitch,
  facePolygons,
  faceOk,
  faceRotation,
  GAP,
  moduleSides,
  outwardNormal,
  setbacksOf,
  type EdgeKind,
  type EnergySetbacks,
  type Inverter,
  type ShutdownInitiator,
  type SolarArray,
} from './energy.js';

export type XY = [number, number];
export type XYZ = [number, number, number];

const RAD = Math.PI / 180;

/** A bearing in degrees clockwise from true north of a plan vector, turned by the site's trueNorth (as @floorspec/analysis's envelope does). */
export function solarBearingOf(doc: FloorspecDocument, nx: number, ny: number): number {
  const trueNorth = (doc.site?.trueNorth ?? 0) / 1e6;
  return (((Math.atan2(nx, ny) / Math.PI) * 180 + trueNorth) % 360 + 360) % 360;
}

/** The compass point of a bearing, in eight: "S", "SW". */
export function compassOf(bearing: number): string {
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((((bearing % 360) + 360) % 360) / 45) % 8]!;
}

/** One edge of a face, in plan, with its kind (4.2) and the setback it keeps. */
export interface DrawFaceEdge {
  readonly a: XY;
  readonly b: XY;
  readonly kind: EdgeKind;
  readonly setback: number;
}

/** A roof face a module could lie on: a derived face of a roof (Core 16.5). */
export interface DrawRoofFace {
  /** `RF1` for a flat roof's face, `RF1:0` for the face of sloped edge 0. */
  readonly key: string;
  readonly roof: string;
  readonly roofName?: string;
  readonly level: string;
  /** The sloped edge it rises from; absent on a flat roof. */
  readonly face?: number;
  /** Every polygon of the face, `[x, y, z]` (a face may be more than one polygon on a weighted roof). */
  readonly polygons: XYZ[][];
  readonly eave: number;
  /** Its slope as written, or null when flat. */
  readonly pitch: { rise: number; run: number } | null;
  /** Its tilt from horizontal, degrees. */
  readonly tilt: number;
  /** The way down its slope in plan, a unit vector; null when flat. */
  readonly downslope: XY | null;
  /** The rotation (microdegrees) a flush array on it has; 0 on a flat roof. */
  readonly rotation: number;
  /** Degrees clockwise from true north the face looks; null when flat. */
  readonly bearing: number | null;
  readonly edges: DrawFaceEdge[];
  /** Plan area, m². */
  readonly planArea: number;
}

/** One module of an array: its corners in 3D, counter-clockwise seen from above, and its centre. */
export interface DrawModule {
  readonly row: number;
  readonly column: number;
  readonly corners: XYZ[];
  readonly centre: XYZ;
  /** Its outward normal (unit), the way it faces the sky. */
  readonly normal: XYZ;
}

/** An array, ready to draw. */
export interface DrawArray {
  readonly id: string;
  readonly name?: string;
  readonly roof: string;
  readonly face?: number;
  readonly level: string;
  readonly mount: 'flush' | 'racked';
  /** The modules' tilt from horizontal, degrees, and the bearing they face (null for flush on a flat roof). */
  readonly tilt: number;
  readonly bearing: number | null;
  /** The exact footprint FS_energy derives (2.4). */
  readonly footprint: XY[];
  readonly modules: DrawModule[];
  readonly rows: number;
  readonly columns: number;
  readonly layout: 'portrait' | 'landscape';
  readonly moduleWatts: number;
  readonly watts: number;
  /** Is every corner clear of its face's setbacks (4.3)? Null when its roof's surface is not derived. */
  readonly clear: boolean | null;
  readonly inverter: string | null;
  readonly rapidShutdown: 'module' | 'array';
}

export interface SolarDrawing {
  readonly faces: DrawRoofFace[];
  readonly arrays: DrawArray[];
  readonly setbacks: EnergySetbacks;
  readonly inverters: [string, Inverter][];
  readonly shutdowns: [string, ShutdownInitiator][];
}

const planArea = (ring: readonly (readonly number[])[]): number => {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    a += p[0]! * q[1]! - q[0]! * p[1]!;
  }
  return Math.abs(a) / 2 / 1_280_000 ** 2;
};

/** The plane z = ax + by + c through a polygon (its first three points that are not on one line). */
function planeOf(poly: readonly (readonly number[])[]): (x: number, y: number) => number {
  const p0 = poly[0]!;
  for (let i = 1; i < poly.length - 1; i++)
    for (let j = i + 1; j < poly.length; j++) {
      const p1 = poly[i]!;
      const p2 = poly[j]!;
      const ux = p1[0]! - p0[0]!, uy = p1[1]! - p0[1]!, uz = p1[2]! - p0[2]!;
      const vx = p2[0]! - p0[0]!, vy = p2[1]! - p0[1]!, vz = p2[2]! - p0[2]!;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (Math.abs(nz) > 1e-6 * Math.hypot(nx, ny, nz) && Math.hypot(nx, ny, nz) > 0) return (x, y) => p0[2]! - (nx * (x - p0[0]!) + ny * (y - p0[1]!)) / nz;
    }
  return () => p0[2]!;
}

/** Every roof face of a document a module could lie on — each sloped edge's face, and each flat roof's one face. */
export function roofFaces(doc: FloorspecDocument, core04 = doc.floorspec === '0.4', derived: Record<string, DerivedRoof> = deriveRoofs(doc, core04)): DrawRoofFace[] {
  const setbacks = setbacksOf(doc);
  const out: DrawRoofFace[] = [];
  for (const [rid, roof] of entries(doc.roofs)) {
    const r = derived[rid];
    if (r?.surface === undefined || r.surface === null) continue;
    const edges = new Set(r.surface.faces.map((f) => f.edge));
    const keys = r.kind === 'flat' ? [undefined] : [...edges].filter((e): e is number => e !== undefined).sort((a, b) => a - b);
    for (const face of keys) {
      const polygons = facePolygons(r, face === undefined ? {} : { face });
      if (polygons.length === 0) continue;
      const pitch = face === undefined ? null : (facePitch(roof, face) ?? null);
      const n = face === undefined ? null : outwardNormal(roof, face);
      const nl = n === null ? 1 : Math.hypot(Number(n[0]), Number(n[1]));
      const downslope: XY | null = n === null ? null : [Number(n[0]) / nl, Number(n[1]) / nl];
      const fEdges: DrawFaceEdge[] = [];
      for (const poly of polygons)
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i]!;
          const b = poly[(i + 1) % poly.length]!;
          const kind = edgeKind(a, b, r.eave);
          fEdges.push({ a: [a[0], a[1]], b: [b[0], b[1]], kind, setback: setbacks[kind] });
        }
      out.push({
        key: face === undefined ? rid : `${rid}:${String(face)}`,
        roof: rid,
        ...(roof.name === undefined ? {} : { roofName: roof.name }),
        level: roof.level,
        ...(face === undefined ? {} : { face }),
        polygons,
        eave: r.eave,
        pitch,
        tilt: pitch === null ? 0 : Math.atan2(pitch.rise, pitch.run) / RAD,
        downslope,
        rotation: face === undefined ? 0 : faceRotation(roof, face),
        bearing: downslope === null ? null : solarBearingOf(doc, downslope[0], downslope[1]),
        edges: fEdges,
        planArea: polygons.reduce((s, p) => s + planArea(p), 0),
      });
    }
  }
  return out;
}

/** The setback strips of a face: for each edge that keeps a setback, the band from the edge inward by it, in plan. */
export function setbackBands(face: DrawRoofFace): { kind: EdgeKind; ring: XY[] }[] {
  const out: { kind: EdgeKind; ring: XY[] }[] = [];
  for (const poly of face.polygons) {
    let s2 = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!;
      const q = poly[(i + 1) % poly.length]!;
      s2 += p[0] * q[1] - q[0] * p[1];
    }
    const ccw = s2 > 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      const kind = edgeKind(a, b, face.eave);
      const s = face.edges.find((e) => e.a[0] === a[0] && e.a[1] === a[1] && e.b[0] === b[0] && e.b[1] === b[1])?.setback ?? 0;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const l = Math.hypot(dx, dy);
      if (s <= 0 || l === 0) continue;
      // Inward: the left of the edge on a counter-clockwise ring.
      const nx = ((ccw ? -dy : dy) / l) * s;
      const ny = ((ccw ? dx : -dx) / l) * s;
      out.push({ kind, ring: [[a[0], a[1]], [b[0], b[1]], [b[0] + nx, b[1] + ny], [a[0] + nx, a[1] + ny]] });
    }
  }
  return out;
}

/** A rack's height above the roof at its front edge, and a flush module's standoff above the face: 150 mm and 100 mm. */
export const RACK_BASE = 192_000;
export const STANDOFF = 128_000;

/** The modules of an array, in 3D, from its frame and its face's plane (or its flat roof's eave). */
export function arrayModules(doc: FloorspecDocument, a: SolarArray, r: DerivedRoof | undefined): DrawModule[] {
  const h = a.host as { position: [number, number]; rotation?: number } | undefined;
  if (h?.position === undefined) return [];
  const f = facingVector(h.rotation ?? 0);
  const fl = Math.hypot(Number(f[0]), Number(f[1]));
  const u: XY = [Number(f[0]) / fl, Number(f[1]) / fl];
  const v: XY = [-u[1], u[0]];
  const O = h.position;
  const at = (p: number, q: number): XY => [O[0] + p * u[0] + q * v[0], O[1] + p * u[1] + q * v[1]];
  const { depth, breadth } = moduleSides(a);
  const gap = a.gap ?? GAP;
  const rowGap = a.rowGap ?? gap;
  const roof = get(doc.roofs, a.roof);
  const polys = r ? facePolygons(r, a) : [];
  const eave = r?.eave ?? 0;
  const plane = polys.length > 0 ? planeOf(polys[0]!) : () => eave;
  const out: DrawModule[] = [];
  const quad = (pts: XYZ[], row: number, column: number) => {
    const c: XYZ = [0, 0, 0];
    for (const p of pts) for (let k = 0; k < 3; k++) c[k]! += p[k]! / pts.length;
    const e1 = [pts[1]![0] - pts[0]![0], pts[1]![1] - pts[0]![1], pts[1]![2] - pts[0]![2]];
    const e2 = [pts[3]![0] - pts[0]![0], pts[3]![1] - pts[0]![1], pts[3]![2] - pts[0]![2]];
    let n: XYZ = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    const nl = Math.hypot(...n) || 1;
    n = [n[0] / nl, n[1] / nl, n[2] / nl];
    if (n[2] < 0) n = [-n[0], -n[1], -n[2]];
    // Counter-clockwise seen from above.
    let s2 = 0;
    for (let i = 0; i < 4; i++) s2 += pts[i]![0] * pts[(i + 1) % 4]![1] - pts[(i + 1) % 4]![0] * pts[i]![1];
    out.push({ row, column, corners: s2 >= 0 ? pts : [...pts].reverse(), centre: c, normal: n });
  };
  if (a.face !== undefined && roof && faceOk(roof, a)) {
    const p = facePitch(roof, a.face)!;
    const cos = p.run / Math.hypot(p.rise, p.run);
    for (let row = 0; row < a.rows; row++)
      for (let col = 0; col < a.columns; col++) {
        const s0 = row * (depth + rowGap);
        const q0 = col * (breadth + gap);
        const pts: XYZ[] = [
          [-s0 * cos, q0],
          [-s0 * cos, q0 + breadth],
          [-(s0 + depth) * cos, q0 + breadth],
          [-(s0 + depth) * cos, q0],
        ].map(([pp, qq]) => {
          const xy = at(pp!, qq!);
          return [xy[0], xy[1], plane(xy[0], xy[1]) + STANDOFF];
        });
        quad(pts, row, col);
      }
  } else if (a.tilt) {
    const t = Math.atan2(a.tilt.rise, a.tilt.run);
    const P = depth * Math.cos(t);
    const lift = depth * Math.sin(t);
    for (let row = 0; row < a.rows; row++)
      for (let col = 0; col < a.columns; col++) {
        const p0 = -row * (P + rowGap);
        const q0 = col * (breadth + gap);
        const front = (q: number): XYZ => {
          const xy = at(p0, q);
          return [xy[0], xy[1], plane(xy[0], xy[1]) + RACK_BASE];
        };
        const back = (q: number): XYZ => {
          const xy = at(p0 - P, q);
          return [xy[0], xy[1], plane(xy[0], xy[1]) + RACK_BASE + lift];
        };
        quad([front(q0), front(q0 + breadth), back(q0 + breadth), back(q0)], row, col);
      }
  } else {
    for (let row = 0; row < a.rows; row++)
      for (let col = 0; col < a.columns; col++) {
        const p0 = -row * (depth + rowGap);
        const q0 = col * (breadth + gap);
        const pts: XYZ[] = [
          [p0, q0],
          [p0, q0 + breadth],
          [p0 - depth, q0 + breadth],
          [p0 - depth, q0],
        ].map(([pp, qq]) => {
          const xy = at(pp!, qq!);
          return [xy[0], xy[1], plane(xy[0], xy[1]) + STANDOFF];
        });
        quad(pts, row, col);
      }
  }
  return out;
}

/** What a document's solar arrays look like: its roof faces, its arrays and their modules. A document that does not use FS_energy has faces and no arrays. */
export function solarDrawing(doc: FloorspecDocument, core04 = doc.floorspec === '0.4'): SolarDrawing {
  const derived = deriveRoofs(doc, core04);
  const faces = roofFaces(doc, core04, derived);
  const setbacks = setbacksOf(doc);
  const inverters = energyCollection<Inverter>(doc, 'inverters');
  const shutdowns = energyCollection<ShutdownInitiator>(doc, 'shutdowns');
  const servedBy = new Map<string, string>();
  for (const [iid, inv] of inverters) for (const x of inv.arrays ?? []) if (!servedBy.has(x)) servedBy.set(x, iid);
  const arrays: DrawArray[] = [];
  for (const [id, a] of energyCollection<SolarArray>(doc, 'pvArrays')) {
    const roof = get(doc.roofs, a.roof);
    const h = a.host as { mode?: string; level?: string; position?: [number, number]; rotation?: number } | undefined;
    if (!roof || h?.mode !== 'free' || h.position === undefined || get(doc.levels, h.level ?? '') === undefined) continue;
    if (!faceOk(roof, a)) continue;
    const r = derived[a.roof];
    let footprint: XY[];
    try {
      footprint = arrayFootprint(doc, a).map((p) => [Number(p[0]), Number(p[1])]);
    } catch {
      continue;
    }
    const polys = r ? facePolygons(r, a) : [];
    const clear = r?.surface === undefined || r.surface === null ? null : arrayFootprint(doc, a).every((c) => cornerClear(c, polys, r.eave, setbacks));
    const tiltPitch = a.face !== undefined ? facePitch(roof, a.face) : a.tilt;
    const f = facingVector(h.rotation ?? 0);
    const flushFlat = a.face === undefined && a.tilt === undefined;
    arrays.push({
      id,
      ...(typeof a.name === 'string' ? { name: a.name } : {}),
      roof: a.roof,
      ...(a.face === undefined ? {} : { face: a.face }),
      level: roof.level,
      mount: a.tilt ? 'racked' : 'flush',
      tilt: tiltPitch ? Math.atan2(tiltPitch.rise, tiltPitch.run) / RAD : 0,
      bearing: flushFlat ? null : solarBearingOf(doc, Number(f[0]), Number(f[1])),
      footprint,
      modules: arrayModules(doc, a, r),
      rows: a.rows,
      columns: a.columns,
      layout: a.layout ?? 'portrait',
      moduleWatts: a.module.watts,
      watts: a.rows * a.columns * a.module.watts,
      clear,
      inverter: servedBy.get(id) ?? null,
      rapidShutdown: a.rapidShutdown ?? 'module',
    });
  }
  return { faces, arrays, setbacks, inverters, shutdowns };
}
