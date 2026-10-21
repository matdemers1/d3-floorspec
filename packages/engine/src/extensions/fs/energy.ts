/**
 * FS_energy 0.1.0 (registry/FS_energy/spec.md, FLR-ADR-065): the energy a house makes on its site —
 * solar arrays on its roofs' derived faces (Core 16.5), flush or racked on a flat roof, the inverters
 * that serve them and the rapid-shutdown initiators that control them. It requires nothing; FS_electrical's
 * circuits name its inverters and initiators as loads (FS_electrical 3.2).
 *
 * Everything normative is exact: an array's frame is its free host's (Core 13.1); its length up the slope
 * is projected to plan once, `round(L·run / √(rise² + run²))`, with the engine's Surd; every corner of its
 * footprint is mapped and rounded once; and its corners are tested against its face's edges in BigInt.
 * Production is informative (chapter 5) and lives in @floorspec/analysis.
 */
import { validate as validateSchema } from '../../generated/validate-FS_energy.js';
import type * as G from '../../generated/types-FS_energy.js';
import { direction, facingVector } from '../../exact/angle.js';
import { Surd } from '../../exact/surd.js';
import { toSafeNumber } from '../../exact/bigint.js';
import { startAtLeast } from '../../derive/level.js';
import { planPoint, type Frame } from '../../derive/frames.js';
import { area2, cross, dot, locate, type IPoint } from '../../geometry/predicates.js';
import { deriveRoofs, edgeKinds, type DerivedRoof } from '../../roofs/roofs.js';
import { entries, get, ipoint, type FloorspecDocument, type Roof } from '../../model/document.js';
import { record, type ExtensionContext, type ExtensionImplementation } from '../context.js';

export type EnergyData = G.FSEnergy010;
export type SolarArray = G.SolarArray;
export type Inverter = G.Inverter;
export type ShutdownInitiator = G.RapidShutdownInitiator;
export type PvModule = G.Module;
export type EnergySetbacks = Required<G.Setbacks>;

export const NAME = 'FS_energy';
const P = (...path: (string | number)[]): string => '/extensions/FS_energy/collections/' + path.join('/');
type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 2.1: the gap between modules when an array does not say: 1″. */
export const GAP = 32_512;
/** 4.1: Floorspec's own round defaults — never a code's: 18″ from an eave, 3′ from a ridge and a rake. */
export const SETBACKS: EnergySetbacks = { eave: 585_216, ridge: 1_170_432, rake: 1_170_432 };

/** Chapter 7: what FS_energy derives. */
export interface DerivedArray {
  roof: string;
  face?: number;
  mount: 'flush' | 'racked';
  pitch: { rise: number; run: number } | null;
  modules: number;
  watts: number;
  area: string;
  footprint: [number, number][];
  inverter: string | null;
}
export interface DerivedEnergy {
  arrays: Record<string, DerivedArray>;
  inverters: Record<string, { arrays: string[]; watts: number }>;
  shutdowns: Record<string, { arrays: string[] }>;
  modules: number;
  watts: number;
}

/** FS_energy's top-level data of a document, or an empty object. */
export function energyData(doc: FloorspecDocument): Json {
  const d = (doc.extensions as Json | undefined)?.[NAME];
  return isObject(d) ? d : {};
}

/** Does this document use FS_energy (declare it)? */
export const usesEnergy = (doc: FloorspecDocument): boolean => isObject(doc.extensionsUsed) && NAME in doc.extensionsUsed;

/** One of FS_energy's collections in a document, sorted by ID. */
export function energyCollection<T>(doc: FloorspecDocument, kind: 'pvArrays' | 'inverters' | 'shutdowns'): [string, T][] {
  const c = energyData(doc).collections;
  return entries((isObject(c) ? c[kind] : undefined) as Record<string, T> | undefined);
}

/** 4.1: the document's setbacks, with their defaults. */
export function setbacksOf(doc: FloorspecDocument): EnergySetbacks {
  const s = energyData(doc).setbacks;
  return { ...SETBACKS, ...(isObject(s) ? (s as Partial<EnergySetbacks>) : {}) };
}

// ── the roof and the face (2.2, 2.3) ─────────────────────────────────────────

const footprintOf = (roof: Roof): IPoint[] => roof.footprint.map(ipoint);

/** Does the roof have a sloped edge (Core 16.2)? */
export const roofSlopes = (roof: Roof): boolean => edgeKinds(roof).includes('sloped');

/** 2.2.2: is the array's `face` right for its roof? */
export function faceOk(roof: Roof, a: SolarArray): boolean {
  if (!roofSlopes(roof)) return a.face === undefined;
  const ks = edgeKinds(roof);
  return a.face !== undefined && a.face < ks.length && ks[a.face] === 'sloped';
}

/** 2.3: the outward normal of footprint edge i, a vector of integers. */
export function outwardNormal(roof: Roof, i: number): IPoint {
  const fp = footprintOf(roof);
  const a = fp[i]!;
  const b = fp[(i + 1) % fp.length]!;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return area2(fp) > 0n ? [dy, -dx] : [-dy, dx];
}

/** 2.3: the rotation a flush array on face i must have — the direction of its outward normal, microdegrees. */
export const faceRotation = (roof: Roof, i: number): number => {
  const n = outwardNormal(roof, i);
  return direction(n[0], n[1]);
};

/** The pitch of sloped edge i as written (Core 16.1): its own, else the roof's. */
export function facePitch(roof: Roof, i: number): { rise: number; run: number } | undefined {
  const e = roof.edges && Object.hasOwn(roof.edges, String(i)) ? roof.edges[String(i)] : undefined;
  return e?.pitch ?? roof.pitch;
}

/** 2.4: round(length × run / √(rise² + run²)), rounded once. */
export function toPlan(length: bigint, pitch: { rise: number; run: number }): bigint {
  const rise = BigInt(pitch.rise);
  const run = BigInt(pitch.run);
  const D = rise * rise + run * run;
  return Surd.sqrt(D).mulInt(length * run).divInt(D).round();
}

/** A module's depth (up the slope) and breadth (along it), 2.4. */
export function moduleSides(a: SolarArray): { depth: number; breadth: number } {
  const portrait = (a.layout ?? 'portrait') === 'portrait';
  return portrait ? { depth: a.module.length, breadth: a.module.width } : { depth: a.module.width, breadth: a.module.length };
}

/** 2.4: the array's depth D and breadth B in plan. Its roof must be a roof of the document. */
export function arrayExtents(doc: FloorspecDocument, a: SolarArray): { D: bigint; B: bigint } {
  const roof = get(doc.roofs, a.roof)!;
  const { depth, breadth } = moduleSides(a);
  const rows = BigInt(a.rows);
  const cols = BigInt(a.columns);
  const gap = BigInt(a.gap ?? GAP);
  const rowGap = BigInt(a.rowGap ?? a.gap ?? GAP);
  const B = cols * BigInt(breadth) + (cols - 1n) * gap;
  let D: bigint;
  if (a.face !== undefined) D = toPlan(rows * BigInt(depth) + (rows - 1n) * rowGap, facePitch(roof, a.face)!);
  else if (a.tilt) D = rows * toPlan(BigInt(depth), a.tilt) + (rows - 1n) * rowGap;
  else D = rows * BigInt(depth) + (rows - 1n) * rowGap;
  return { D, B };
}

/** 2.3: the array's frame — its free host's (Core 13.1). */
export function arrayFrame(doc: FloorspecDocument, a: SolarArray): Frame {
  const h = a.host as { mode: 'free'; level: string; position: [number, number]; rotation?: number };
  return { ox: Surd.of(BigInt(h.position[0])), oy: Surd.of(BigInt(h.position[1])), oz: BigInt(get(doc.levels, h.level)!.elevation), f: facingVector(h.rotation ?? 0) };
}

/** 2.4: the array's footprint — the box from (−D, 0) to (0, B) in its frame, each corner rounded once, least first, counter-clockwise. */
export function arrayFootprint(doc: FloorspecDocument, a: SolarArray): IPoint[] {
  const { D, B } = arrayExtents(doc, a);
  const fr = arrayFrame(doc, a);
  const corners: [bigint, bigint][] = [
    [-D, 0n],
    [0n, 0n],
    [0n, B],
    [-D, B],
  ];
  return startAtLeast(
    corners.map(([p, q]): IPoint => {
      const pt = planPoint(fr, p, q);
      return [pt.x.round(), pt.y.round()];
    }),
  );
}

// ── setbacks (4.2, 4.3) ──────────────────────────────────────────────────────

export type EdgeKind = 'eave' | 'ridge' | 'rake';

/** 4.2: an edge of a face, by the elevations of its ends. */
export const edgeKind = (a: readonly number[], b: readonly number[], eave: number): EdgeKind => (a[2] === b[2] ? (a[2] === eave ? 'eave' : 'ridge') : 'rake');

/** 4.3: is c nearer than s to the segment ab? In BigInt. */
export function tooNear(c: IPoint, a: IPoint, b: IPoint, s: bigint): boolean {
  const ab: IPoint = [b[0] - a[0], b[1] - a[1]];
  const ac: IPoint = [c[0] - a[0], c[1] - a[1]];
  const L2 = dot(ab, ab);
  const t = dot(ac, ab);
  if (L2 === 0n || t <= 0n) return dot(ac, ac) < s * s;
  if (t >= L2) {
    const bc: IPoint = [c[0] - b[0], c[1] - b[1]];
    return dot(bc, bc) < s * s;
  }
  const cr = cross(ab, ac);
  return cr * cr < s * s * L2;
}

/** 2.2: the polygons of the array's face — every derived face of its roof with its `face` as `edge`, or a flat roof's one face. */
export function facePolygons(r: DerivedRoof, a: Pick<SolarArray, 'face'>): [number, number, number][][] {
  const faces = r.surface?.faces ?? [];
  return a.face !== undefined ? faces.filter((f) => f.edge === a.face).map((f) => f.polygon) : faces.slice(0, 1).map((f) => f.polygon);
}

/** 4.3: is a corner clear — in one of the face's polygons and at least its setback from each of that polygon's edges? */
export function cornerClear(c: IPoint, polys: readonly (readonly (readonly number[])[])[], eave: number, setbacks: EnergySetbacks): boolean {
  for (const poly of polys) {
    const ring = poly.map((p): IPoint => [BigInt(p[0]!), BigInt(p[1]!)]);
    if (locate(c, ring) === 'outside') continue;
    const n = poly.length;
    let ok = true;
    for (let i = 0; i < n && ok; i++) if (tooNear(c, ring[i]!, ring[(i + 1) % n]!, BigInt(setbacks[edgeKind(poly[i]!, poly[(i + 1) % n]!, eave)]))) ok = false;
    if (ok) return true;
  }
  return false;
}

/** Array ID → the inverters that list it, sorted. */
function servedBy(doc: FloorspecDocument): Map<string, string[]> {
  const ids = new Set(energyCollection<SolarArray>(doc, 'pvArrays').map(([id]) => id));
  const out = new Map<string, string[]>();
  for (const [iid, inv] of energyCollection<Inverter>(doc, 'inverters'))
    for (const x of inv.arrays ?? [])
      if (ids.has(x)) {
        const l = out.get(x) ?? [];
        l.push(iid);
        out.set(x, l);
      }
  return out;
}

// ── the extension ─────────────────────────────────────────────────────────────

function invariants(ctx: ExtensionContext): void {
  const arrays = ctx.coll<SolarArray>('pvArrays');
  const ids = new Set(arrays.map(([id]) => id));
  for (const [id, a] of arrays) {
    const roof = get(ctx.doc.roofs, a.roof);
    if (!roof) {
      ctx.report('FS-ENGY-INV-001', `Array ${id} is on ${a.roof}, which is not a roof of the document.`, [id], P('pvArrays', id, 'roof'));
      continue;
    }
    const fok = faceOk(roof, a);
    if (!fok)
      ctx.report(
        'FS-ENGY-INV-002',
        roofSlopes(roof) ? `Array ${id} names no sloped edge of ${a.roof} as its face: give the index of the edge whose face it lies on.` : `Array ${id} names a face of ${a.roof}, a flat roof, which has one face and no sloped edge.`,
        [id],
        P('pvArrays', id, 'face'),
      );
    const h = a.host as { mode?: string; level?: string; rotation?: number } | undefined;
    const hok = h?.mode === 'free' && h.level === roof.level;
    if (!hok) ctx.report('FS-ENGY-INV-003', `Array ${id} must stand on a free host on ${roof.level}, its roof's level.`, [id], P('pvArrays', id, 'host'));
    if (fok && hok && a.face !== undefined && ((h.rotation ?? 0) !== faceRotation(roof, a.face) || a.tilt !== undefined))
      ctx.report(
        'FS-ENGY-INV-004',
        a.tilt !== undefined ? `Array ${id} is racked on a sloped face: racks stand on a flat roof.` : `Array ${id} must face the way its face does: rotation ${faceRotation(roof, a.face)}.`,
        [id],
        P('pvArrays', id, a.tilt !== undefined ? 'tilt' : 'host'),
      );
  }
  for (const kind of ['inverters', 'shutdowns'] as const)
    for (const [id, el] of ctx.coll<{ arrays?: string[] }>(kind))
      if ((el.arrays ?? []).some((x) => !ids.has(x))) ctx.report('FS-ENGY-INV-005', `${id} lists something that is not an array of FS_energy among its arrays.`, [id], P(kind, id, 'arrays'));
  for (const [aid, invs] of [...servedBy(ctx.doc)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    if (invs.length > 1) ctx.report('FS-ENGY-INV-006', `Array ${aid} is served by ${invs.join(' and ')}: an array has one inverter.`, [aid, ...invs]);
}

function lints(ctx: ExtensionContext): void {
  const roofs = deriveRoofs(ctx.doc, ctx.analysis.core04 ?? false);
  const setbacks = setbacksOf(ctx.doc);
  const served = servedBy(ctx.doc);
  for (const [id, a] of ctx.coll<SolarArray>('pvArrays')) {
    const r = roofs[a.roof]!;
    if (r.surface === null) ctx.report('FS-ENGY-LINT-003', `Array ${id} is on ${a.roof}, whose surface is not derived: it cannot be laid on a face.`, [id]);
    else {
      const polys = facePolygons(r, a);
      if (!arrayFootprint(ctx.doc, a).every((c) => cornerClear(c, polys, r.eave, setbacks)))
        ctx.report('FS-ENGY-LINT-001', `A corner of array ${id} is off its face or inside the setback from an eave, a ridge or a rake.`, [id]);
    }
    if (!served.has(id)) ctx.report('FS-ENGY-LINT-002', `No inverter serves array ${id}.`, [id]);
  }
}

function derive(ctx: ExtensionContext): DerivedEnergy {
  const served = servedBy(ctx.doc);
  const arrays: [string, DerivedArray][] = ctx.coll<SolarArray>('pvArrays').map(([id, a]) => {
    const roof = get(ctx.doc.roofs, a.roof)!;
    const n = a.rows * a.columns;
    const v: DerivedArray = {
      roof: a.roof,
      ...(a.face !== undefined && { face: a.face }),
      mount: a.tilt ? 'racked' : 'flush',
      pitch: a.face !== undefined ? facePitch(roof, a.face)! : (a.tilt ?? null),
      modules: n,
      watts: n * a.module.watts,
      area: (BigInt(n) * BigInt(a.module.width) * BigInt(a.module.length)).toString(),
      footprint: arrayFootprint(ctx.doc, a).map((p) => [toSafeNumber(p[0]), toSafeNumber(p[1])]),
      inverter: served.get(id)?.[0] ?? null,
    };
    return [id, v];
  });
  const byId = new Map(arrays);
  return {
    arrays: record(arrays),
    inverters: record(
      ctx.coll<Inverter>('inverters').map(([id, inv]) => {
        const xs = [...(inv.arrays ?? [])].sort();
        return [id, { arrays: xs, watts: xs.reduce((s, x) => s + (byId.get(x)?.watts ?? 0), 0) }] as const;
      }),
    ),
    shutdowns: record(ctx.coll<ShutdownInitiator>('shutdowns').map(([id, s]) => [id, { arrays: [...(s.arrays ?? [])].sort() }] as const)),
    modules: arrays.reduce((s, [, v]) => s + v.modules, 0),
    watts: arrays.reduce((s, [, v]) => s + v.watts, 0),
  };
}

export const FS_ENERGY: ExtensionImplementation<DerivedEnergy> = {
  name: NAME,
  version: '0.1.0',
  code: 'ENGY',
  catalogue: [
    { code: 'FS-ENGY-SCH-001', severity: 'error', condition: 'the top-level data does not match the schema' },
    { code: 'FS-ENGY-INV-001', severity: 'error', condition: "an array whose `roof` is not the ID of a roof" },
    { code: 'FS-ENGY-INV-002', severity: 'error', condition: "an array whose `face` is missing on a roof that slopes, is not the index of a sloped edge of it, or is present on a flat roof" },
    { code: 'FS-ENGY-INV-003', severity: 'error', condition: "an array without a host, or whose host is not a `free` host on its roof's level" },
    { code: 'FS-ENGY-INV-004', severity: 'error', condition: "an array with a `face` whose host's rotation is not the direction of its face's outward normal, or that has a `tilt`" },
    { code: 'FS-ENGY-INV-005', severity: 'error', condition: 'an inverter or a shutdown initiator whose `arrays` lists an ID that is not an array of FS_energy' },
    { code: 'FS-ENGY-INV-006', severity: 'error', condition: 'an array listed by more than one inverter' },
    { code: 'FS-ENGY-LINT-001', severity: 'warning', condition: "an array a corner of whose footprint is not clear of its face's edges" },
    { code: 'FS-ENGY-LINT-002', severity: 'info', condition: 'an array no inverter serves' },
    { code: 'FS-ENGY-LINT-003', severity: 'warning', condition: 'an array on a roof whose surface Core does not derive' },
  ],
  validate: (data) => validateSchema(data),
  invariants,
  lints,
  derive,
};
