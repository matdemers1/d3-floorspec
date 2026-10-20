import { contextDrawing, documentIds, exactRectangle, generateContext, generatedIds, isGenerated, type ContextDrawing, type FloorspecDocument, type GenerateContextOptions } from '@floorspec/engine';
import type { Batch, BatchBuilder } from '../ops';
import type { EditorModel, Point } from '../model';
import { declarationOps } from '../systems/ops';
import type { ContextMember, ContextState } from './state';

/**
 * Context as Ops (FLR-T-15.3, FLR-ADR-064): FS_context 0.1.0's records — streets, neighbours and trees
 * — on `$document`, setProperty to add or change one and unsetProperty to remove it, as FS_site's survey
 * is written. Ops mints no record IDs: the editor takes the next free `ST<n>`, `NB<n>` or `TR<n>`.
 * Context is never the design: nothing here touches an element.
 */

export const FT = 390_144;
type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const round = (p: Point): [number, number] => [Math.round(p[0]) + 0, Math.round(p[1]) + 0];
const P = (...path: string[]): string => `/extensions/FS_context/${path.join('/')}`;
const PREFIX: Record<ContextMember, string> = { streets: 'ST', neighbours: 'NB', trees: 'TR' };

/** FS_context's data in a document, or an empty object. */
export function contextDataOf(document: FloorspecDocument): Json {
  const ext = isObject(document.extensions) ? document.extensions : {};
  const d = ext['FS_context'];
  return isObject(d) ? d : {};
}

const drawings = new WeakMap<EditorModel, ContextDrawing>();

/** The model's context, drawn once per model. */
export function contextDrawingOf(model: EditorModel): ContextDrawing {
  let d = drawings.get(model);
  if (d === undefined) {
    d = contextDrawing(model.document);
    drawings.set(model, d);
  }
  return d;
}

/** The next free ID with a member's prefix, `skip` past it on a retry. */
export function nextContextId(model: EditorModel, member: ContextMember, skip = 0): string {
  const used = documentIds(model.document);
  const prefix = PREFIX[member];
  let k = 1 + skip;
  while (used.has(`${prefix}${String(k)}`)) k++;
  return `${prefix}${String(k)}`;
}

const declare = (model: EditorModel): Batch => declarationOps(model.document, 'FS_context');

/** The generator's options from the panel's settings. */
export function generateOptions(state: Pick<ContextState, 'side' | 'width' | 'sidewalk' | 'strip' | 'neighbours' | 'trees' | 'seed'>, name?: string): GenerateContextOptions {
  return {
    ...(state.side === null ? {} : { side: state.side }),
    width: Math.round(state.width * FT),
    sidewalk: Math.round(state.sidewalk * FT),
    strip: Math.round(state.strip * FT),
    neighbours: state.neighbours,
    trees: state.trees,
    seed: state.seed,
    ...(name === undefined ? {} : { name }),
  };
}

/**
 * Generate context from the street side and the setbacks (FS_context 6.3): the generated records the
 * document has are replaced — what a person drew by hand stays — and the street keeps its name. One batch,
 * one undo. Null, with the reason, when there is no lot.
 */
export function generateOps(model: EditorModel, options: GenerateContextOptions): { batch: Batch; reason?: string; counts: { streets: number; neighbours: number; trees: number } } {
  const old = generatedIds(model.document);
  const data = contextDataOf(model.document);
  // the street's name, kept across a regeneration
  const named = old.filter((o) => o.member === 'streets').map((o) => (data['streets'] as Record<string, Json>)[o.id]?.['name']).find((n): n is string => typeof n === 'string');
  // generate as if the old generated records were gone, so their IDs are free again
  const without = structuredClone(model.document) as FloorspecDocument & { extensions?: Record<string, Json> };
  const d = without.extensions?.['FS_context'];
  if (isObject(d)) for (const o of old) delete (d[o.member] as Json | undefined)?.[o.id];
  const g = generateContext(without, { ...options, ...(options.name === undefined && named !== undefined ? { name: named } : {}) });
  const counts = { streets: Object.keys(g.streets).length, neighbours: Object.keys(g.neighbours).length, trees: Object.keys(g.trees).length };
  if (g.reason !== undefined) return { batch: [], reason: g.reason, counts };
  const batch: Batch = [...declare(model), ...old.map((o): Batch[number] => ({ op: 'unsetProperty', id: '$document', path: P(o.member, o.id) }))];
  for (const member of ['streets', 'neighbours', 'trees'] as const) for (const [id, r] of Object.entries(g[member])) batch.push({ op: 'setProperty', id: '$document', path: P(member, id), value: r as unknown as Json });
  return { batch, counts };
}

/** Remove every context record: the generated and the hand-drawn. */
export function clearContext(model: EditorModel): Batch {
  const data = contextDataOf(model.document);
  const out: Batch = [];
  for (const member of ['streets', 'neighbours', 'trees'] as const) {
    const m = data[member];
    if (isObject(m)) for (const id of Object.keys(m)) out.push({ op: 'unsetProperty', id: '$document', path: P(member, id) });
  }
  return out;
}

/** A tree beyond the lot where the plan was clicked: 35′ deciduous, 28′ across, or a 40′ evergreen, 16′ across. */
export function addTree(model: EditorModel, at: Point, form: 'deciduous' | 'evergreen'): BatchBuilder {
  const value = form === 'evergreen' ? { at: round(at), height: 40 * FT, spread: 16 * FT, form: 'evergreen' } : { at: round(at), height: 35 * FT, spread: 28 * FT };
  return (attempt) => [...declare(model), { op: 'setProperty', id: '$document', path: P('trees', nextContextId(model, 'trees', attempt)), value }];
}

/** Is a four-cornered outline near enough a rectangle to take a gable: every corner within 3° of square? */
function nearlyRectangle(points: readonly Point[]): boolean {
  if (points.length !== 4) return false;
  return points.every((b, i) => {
    const a = points[(i + 3) % 4] ?? b;
    const c = points[(i + 1) % 4] ?? b;
    const u = [b[0] - a[0], b[1] - a[1]] as const;
    const v = [c[0] - b[0], c[1] - b[1]] as const;
    const cos = (u[0] * v[0] + u[1] * v[1]) / (Math.hypot(u[0], u[1]) * Math.hypot(v[0], v[1]) || 1);
    return Math.abs(cos) <= Math.sin((3 * Math.PI) / 180);
  });
}

const sideLength = (a: readonly [number, number] | undefined, b: readonly [number, number] | undefined): number => (a === undefined || b === undefined ? 0 : Math.hypot(b[0] - a[0], b[1] - a[1]));

/**
 * A neighbour drawn by hand: its footprint's corners. Four corners near square are made an exact
 * rectangle under a 6:12 gable (FS_context 3.2); any other outline is flat-roofed massing. One storey, 10′ to the eaves.
 */
export function addNeighbour(model: EditorModel, points: readonly Point[]): BatchBuilder {
  const rect = nearlyRectangle(points);
  const boundary = rect ? exactRectangle(points.map((p) => [p[0], p[1]] as [number, number])) : points.map(round);
  let value: Json = { boundary, height: 10 * FT };
  if (rect) {
    const s = Math.min(sideLength(boundary[0], boundary[1]), sideLength(boundary[1], boundary[2]));
    value = { ...value, roof: 'gable', rise: Math.round(s / 4 / (FT / 4)) * (FT / 4) };
  }
  return (attempt) => [...declare(model), { op: 'setProperty', id: '$document', path: P('neighbours', nextContextId(model, 'neighbours', attempt)), value }];
}

/** A street drawn by hand along its centreline, with the panel's carriageway, strip and sidewalk; consecutive repeats dropped (FS_context 2.1.1). */
export function addStreet(model: EditorModel, points: readonly Point[], state: Pick<ContextState, 'width' | 'sidewalk' | 'strip'>): BatchBuilder {
  const pts: [number, number][] = [];
  for (const p of points.map(round)) {
    const last = pts[pts.length - 1];
    if (last === undefined || last[0] !== p[0] || last[1] !== p[1]) pts.push(p);
  }
  const value: Json = { points: pts, width: Math.max(1, Math.round(state.width * FT)), ...(state.strip > 0 ? { strip: Math.round(state.strip * FT) } : {}), ...(state.sidewalk > 0 ? { sidewalk: Math.round(state.sidewalk * FT) } : {}) };
  return (attempt) => [...declare(model), { op: 'setProperty', id: '$document', path: P('streets', nextContextId(model, 'streets', attempt)), value }];
}

/** The record as the document holds it. */
export function recordOf(model: EditorModel, member: ContextMember, id: string): Json | undefined {
  const m = contextDataOf(model.document)[member];
  const r = isObject(m) ? m[id] : undefined;
  return isObject(r) ? r : undefined;
}

/** Move a record by (dx, dy): its points, footprint or position. */
export function moveContext(model: EditorModel, member: ContextMember, id: string, dx: number, dy: number): Batch {
  const r = recordOf(model, member, id);
  if (r === undefined) return [];
  const shift = (p: unknown): [number, number] => {
    const [x = 0, y = 0] = p as number[];
    return round([x + dx, y + dy]);
  };
  if (member === 'trees') return [{ op: 'setProperty', id: '$document', path: P(member, id, 'at'), value: shift(r['at']) }];
  const key = member === 'streets' ? 'points' : 'boundary';
  return [{ op: 'setProperty', id: '$document', path: P(member, id, key), value: (r[key] as unknown[]).map(shift) }];
}

/** Remove one record. */
export const removeContext = (member: ContextMember, id: string): Batch => [{ op: 'unsetProperty', id: '$document', path: P(member, id) }];

/** Set or clear one member of a record. */
export const setContextField = (member: ContextMember, id: string, field: string, value: unknown): Batch =>
  value === null || value === undefined ? [{ op: 'unsetProperty', id: '$document', path: P(member, id, field) }] : [{ op: 'setProperty', id: '$document', path: P(member, id, field), value: value }];

/** Was a record generated (and so replaced by Regenerate)? */
export const generatedRecord = (model: EditorModel, member: ContextMember, id: string): boolean => isGenerated(recordOf(model, member, id));

/** The context record under a plan point: a tree's crown, a neighbour's footprint, a street's width. */
export function contextAt(model: EditorModel, at: Point, tol: number): { member: ContextMember; id: string } | null {
  const ctx = contextDrawingOf(model);
  // the tree whose trunk is nearest, of those whose crown is under the point
  let tree: { id: string; d: number } | null = null;
  for (const t of ctx.trees) {
    const d = Math.hypot(at[0] - t.at[0], at[1] - t.at[1]);
    if (d <= t.spread / 2 + tol && (tree === null || d < tree.d)) tree = { id: t.id, d };
  }
  if (tree !== null) return { member: 'trees', id: tree.id };
  for (const n of [...ctx.neighbours].reverse()) if (inside(at, n.footprint)) return { member: 'neighbours', id: n.id };
  for (const s of ctx.streets)
    for (const [i, a] of s.centreline.entries()) {
      const b = s.centreline[i + 1];
      if (b !== undefined && segDist(at, a, b) <= s.overall / 2 + tol) return { member: 'streets', id: s.id };
    }
  return null;
}

function inside(p: Point, ring: readonly (readonly [number, number])[]): boolean {
  let w = false;
  for (const [i, a] of ring.entries()) {
    const b = ring[(i + ring.length - 1) % ring.length] ?? a;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) w = !w;
  }
  return w;
}

function segDist(p: Point, a: readonly [number, number], b: readonly [number, number]): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const l = vx * vx + vy * vy;
  const t = l === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l));
  return Math.hypot(p[0] - a[0] - t * vx, p[1] - a[1] - t * vy);
}
