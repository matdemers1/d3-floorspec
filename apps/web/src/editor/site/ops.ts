import { outerBoundary } from '@floorspec/render2d';
import { siteDrawing, gradeAt } from '@floorspec/engine';
import type { Batch, BatchBuilder } from '../ops';
import type { EditorModel, LevelView, Point } from '../model';
import { declarationOps } from '../systems/ops';
import { annoSourceOfLevel } from '../annotate/source';

/**
 * The site as Ops (FLR-T-15.1, FLR-ADR-060): the lot is Core's `$site /boundary`; the setbacks, the
 * survey (spots and contour lines) and the grading pads are FS_site 0.1.0's records on `$document`,
 * setProperty to add or change one and unsetProperty to remove it. Ops mints no record IDs: the editor
 * takes the next free `SP<n>`, `CT<n>` or `PAD<n>`.
 */

export const FT = 390_144;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const round = (p: Point): [number, number] => [Math.round(p[0]), Math.round(p[1])];
const P = (...path: string[]): string => `/extensions/FS_site/${path.join('/')}`;

export type SiteMember = 'spots' | 'contours' | 'pads';
export type SetbackKind = 'front' | 'side' | 'rear';

/** FS_site's data in a document, or an empty object. */
export function siteDataOf(model: EditorModel): Json {
  const ext = isObject(model.document.extensions) ? model.document.extensions : {};
  const d = ext['FS_site'];
  return isObject(d) ? d : {};
}

/** The survey's elevation of project zero (FS_site 1.4). */
export const benchmarkOf = (model: EditorModel): number => {
  const b = siteDataOf(model)['benchmark'];
  return typeof b === 'number' ? b : 0;
};

/** A height in the survey's datum as the panel shows it: "814.50". */
export const heightText = (z: number, benchmark: number): string => ((benchmark + z) / FT).toFixed(2);

/** A typed height — survey feet, "811.25", "811.25'" or "811.25 ft" — as an elevation above project zero; null when it does not parse. */
export function parseHeight(text: string, benchmark: number): number | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(?:'|′|ft)?\s*$/.exec(text);
  if (m === null) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) && Math.abs(v) < 1e6 ? Math.round(v * FT) - benchmark : null;
}

/** The ground's height at a point, from the survey: the elevation, or null beyond it. */
export function groundAt(model: EditorModel, at: Point): number | null {
  const s = siteDrawing(model.view).surface;
  const g = s === null ? undefined : gradeAt(s, at[0], at[1]);
  return g === undefined ? null : Math.round(g);
}

/** Every ID the document uses: elements, items, extension elements, records and every extension's record maps. */
function usedIds(model: EditorModel): Set<string> {
  const ids = new Set<string>([...model.index.keys(), ...model.ext.keys(), ...model.records.keys()]);
  const ext = isObject(model.document.extensions) ? model.document.extensions : {};
  for (const data of Object.values(ext))
    if (isObject(data)) for (const member of Object.values(data)) if (isObject(member)) for (const id of Object.keys(member)) ids.add(id);
  return ids;
}

/** The next free ID with a prefix, `skip` past it on a retry. */
export function nextSiteId(model: EditorModel, prefix: 'SP' | 'CT' | 'PAD', skip = 0): string {
  const used = usedIds(model);
  let n = 0;
  for (const id of used) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(id);
    if (m !== null) n = Math.max(n, Number(m[1]));
  }
  let k = n + 1 + skip;
  while (used.has(`${prefix}${String(k)}`)) k++;
  return `${prefix}${String(k)}`;
}

const declare = (model: EditorModel): Batch => declarationOps(model.document, 'FS_site');

/** Draw the lot (Core 1.8): its corners, as given; setbacks naming an edge it no longer has move to edge 0. */
export function setLot(model: EditorModel, points: readonly Point[]): Batch {
  const ops: Batch = [{ op: 'setProperty', id: '$site', path: '/boundary', value: points.map(round) }];
  const sb = siteDataOf(model)['setbacks'];
  if (isObject(sb) && Array.isArray(sb['street']) && (sb['street'] as number[]).some((i) => i >= points.length)) ops.push({ op: 'setProperty', id: '$document', path: P('setbacks', 'street'), value: [0] });
  return ops;
}

/** Remove the lot, and the setbacks that are drawn from it. */
export function removeLot(model: EditorModel): Batch {
  const ops: Batch = [{ op: 'unsetProperty', id: '$site', path: '/boundary' }];
  if (isObject(siteDataOf(model)['setbacks'])) ops.push({ op: 'unsetProperty', id: '$document', path: P('setbacks') });
  return ops;
}

/** The design's starting setbacks: 30′ at the front, 10′ at the sides, 25′ at the rear. Values a person types; never a code's. */
export const DEFAULT_SETBACKS = { front: 30 * FT, side: 10 * FT, rear: 25 * FT } as const;

/** Make an edge of the lot the street — the front — and give the lot setbacks if it had none. */
export function setStreet(model: EditorModel, edge: number): Batch {
  const sb = siteDataOf(model)['setbacks'];
  if (isObject(sb)) return [{ op: 'setProperty', id: '$document', path: P('setbacks', 'street'), value: [edge] }];
  return [...declare(model), { op: 'setProperty', id: '$document', path: P('setbacks'), value: { street: [edge], ...DEFAULT_SETBACKS } }];
}

/** Set or clear one setback distance. */
export function setSetback(model: EditorModel, kind: SetbackKind, value: number | null): Batch {
  const sb = siteDataOf(model)['setbacks'];
  if (!isObject(sb)) return value === null ? [] : [...declare(model), { op: 'setProperty', id: '$document', path: P('setbacks'), value: { street: [0], [kind]: value } }];
  return value === null ? [{ op: 'unsetProperty', id: '$document', path: P('setbacks', kind) }] : [{ op: 'setProperty', id: '$document', path: P('setbacks', kind), value }];
}

/** Set the survey's benchmark: its elevation of project zero. */
export function setBenchmark(model: EditorModel, value: number): Batch {
  return [...declare(model), { op: 'setProperty', id: '$document', path: P('benchmark'), value }];
}

/** A spot elevation at a point. */
export function addSpot(model: EditorModel, at: Point, elevation: number): BatchBuilder {
  return (attempt) => [...declare(model), { op: 'setProperty', id: '$document', path: P('spots', nextSiteId(model, 'SP', attempt)), value: { at: round(at), elevation } }];
}

/** A contour line through points at one elevation; consecutive repeats dropped (FS_site 3.1.1). */
export function addContour(model: EditorModel, points: readonly Point[], elevation: number): BatchBuilder {
  const pts: [number, number][] = [];
  for (const p of points.map(round)) {
    const last = pts[pts.length - 1];
    if (last === undefined || last[0] !== p[0] || last[1] !== p[1]) pts.push(p);
  }
  return (attempt) => [...declare(model), { op: 'setProperty', id: '$document', path: P('contours', nextSiteId(model, 'CT', attempt)), value: { elevation, points: pts } }];
}

/** A grading pad: an outline at an elevation. */
export function addPad(model: EditorModel, boundary: readonly Point[], elevation: number, name?: string): BatchBuilder {
  return (attempt) => [
    ...declare(model),
    { op: 'setProperty', id: '$document', path: P('pads', nextSiteId(model, 'PAD', attempt)), value: { boundary: boundary.map(round), elevation, ...(name === undefined ? {} : { name }) } },
  ];
}

/** Remove a spot, a contour line or a pad. */
export const removeRecord = (member: SiteMember, id: string): Batch => [{ op: 'unsetProperty', id: '$document', path: P(member, id) }];

/** Change a record's elevation. */
export const setElevation = (member: SiteMember, id: string, elevation: number): Batch => [{ op: 'setProperty', id: '$document', path: P(member, id, 'elevation'), value: elevation }];

/** The house's outline on a level: its walls' outside faces, the largest loop. */
export function houseOutline(level: LevelView, model: EditorModel): Point[] | null {
  const loops = outerBoundary(annoSourceOfLevel(level, model.document));
  const best = [...loops].sort((a, b) => b.length - a.length)[0];
  return best === undefined || best.length < 3 ? null : best.map((p) => [Math.round(p[0]), Math.round(p[1])] as Point);
}

/** The house's pad: the pad named "House", if there is one. */
export function housePadOf(model: EditorModel): { id: string; elevation: number } | null {
  const pads = siteDataOf(model)['pads'];
  if (!isObject(pads)) return null;
  for (const [id, p] of Object.entries(pads)) if (isObject(p) && p['name'] === 'House' && typeof p['elevation'] === 'number') return { id, elevation: p['elevation'] };
  return null;
}

/**
 * Fit the house's pad to its walls (FS_site 4.1: a writer keeps it fitted): the walls' outside faces on
 * the level, at its elevation — 8″ under the floor for a new pad. The ground moves; the house does not.
 */
export function fitHousePad(model: EditorModel, level: LevelView, elevation?: number): Batch | BatchBuilder | null {
  const outline = houseOutline(level, model);
  if (outline === null) return null;
  const pad = housePadOf(model);
  const floor = model.document.levels?.[level.id]?.elevation ?? 0;
  if (pad !== null) return [{ op: 'setProperty', id: '$document', path: P('pads', pad.id, 'boundary'), value: outline }, ...(elevation === undefined ? [] : setElevation('pads', pad.id, elevation))];
  return addPad(model, outline, elevation ?? floor - 8 * 32_512, 'House');
}
