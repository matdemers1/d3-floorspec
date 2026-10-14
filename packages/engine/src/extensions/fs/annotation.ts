/**
 * FS_annotation 0.1.0 (registry/FS_annotation/spec.md, FLR-ADR-047): the drawing annotation a house's
 * owner keeps — dimension strings associated with the junctions, wall faces and opening centres they
 * measure, and notes with leaders. It adds no kind of element and requires no other extension; the
 * IDs of FS_lighting's scenes and FS_views's views are read from their data as it is.
 *
 * A string's lengths are derived exactly (2.3): each anchor's position along it, times |d|, is
 * `α + β·√m` — m the squared length of the wall it measures — so a length `|s' − s| / |d|` is a Surd
 * of at most three generators, rounded once. `measureDimension` is that computation from a document
 * alone; the extension derives with it, and `resolveAnnotations` — what the editor, the 2D renderer and
 * the PDF draw from — uses it too, so a drawn length is always the derived one.
 */
import { validate as validateSchema } from '../../generated/validate-FS_annotation.js';
import type * as G from '../../generated/types-FS_annotation.js';
import { Surd } from '../../exact/surd.js';
import { Q } from '../../exact/rational.js';
import { toSafeNumber } from '../../exact/bigint.js';
import { pointAt, sagittaOf } from '../../geometry/arcs.js';
import { effectiveLayers, faceOffsets, get, ipoint, openingDimensions, wallArc, type FloorspecDocument } from '../../model/document.js';
import type { Derived } from '../../derive/derive.js';
import type { Evaluation } from '../../validate/validate.js';
import { record, type ExtensionContext, type ExtensionImplementation } from '../context.js';

export type AnnotationData = G.FSAnnotation010;
export type DimensionString = G.DimensionString;
export type Note = G.Note;
export type Anchor = G.Anchor;

/** Chapter 6: what FS_annotation derives. */
export interface DerivedAnnotation {
  dimensions: Record<string, { level: string; lengths: number[] | null; total: number | null }>;
  notes: Record<string, { level: string; about: string | null }>;
}

const NAME = 'FS_annotation';
const P = (...path: (string | number)[]): string => '/extensions/FS_annotation/' + path.join('/');

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The IDs of `extensions.<name>.<member>`, read as data (FS-ANNO-1.3): a member that is not an object holds none. */
function idsOf(doc: FloorspecDocument, name: string, member: string): string[] {
  const data = (doc.extensions as Json | undefined)?.[name];
  const m = isObject(data) ? data[member] : undefined;
  return isObject(m) ? Object.keys(m) : [];
}

/** FS-ANNO-1.3: FS_lighting's scenes and FS_views's views, read as data. */
export const scenesAndViews = (doc: FloorspecDocument): Set<string> => new Set([...idsOf(doc, 'FS_lighting', 'scenes'), ...idsOf(doc, 'FS_views', 'views')]);

// ── anchors (2.2) and measuring (2.3) ─────────────────────────────────────────

/** Why an anchor cannot be measured: `missing` (FS-ANNO-LINT-001) or `unmeasurable` (FS-ANNO-LINT-002); undefined when it can. */
export type AnchorProblem = 'missing' | 'unmeasurable';

const big = BigInt;

/** The line a wall anchor names, `ν · (P − S) = (λ2 / 2) · |e|`, with its face offset doubled. */
function wallLine(doc: FloorspecDocument, wid: string, face: 'left' | 'right' | 'location'): { S: readonly [bigint, bigint]; e: [bigint, bigint]; nu: [bigint, bigint]; lam2: bigint } | undefined {
  const w = get(doc.walls, wid);
  const s = w && get(doc.junctions, w.start);
  const t = w && get(doc.junctions, w.end);
  if (!w || !s || !t) return undefined;
  const layers = effectiveLayers(doc, w);
  const off = layers && faceOffsets(w, layers);
  if (!off) return undefined;
  const S = ipoint(s.position);
  const E = ipoint(t.position);
  const e: [bigint, bigint] = [E[0] - S[0], E[1] - S[1]];
  return { S, e, nu: [-e[1], e[0]], lam2: face === 'left' ? off.a2 : face === 'right' ? -off.b2 : 0n };
}

/** FS-ANNO-2.2.1 and 2.2.2: what keeps one anchor of a string from being measured, if anything. */
export function anchorProblem(doc: FloorspecDocument, dim: Pick<DimensionString, 'level' | 'direction'>, a: Anchor): AnchorProblem | undefined {
  if ('point' in a) return undefined;
  if ('junction' in a) {
    const j = get(doc.junctions, a.junction);
    return j && j.level === dim.level ? undefined : 'missing';
  }
  if ('opening' in a) {
    const o = get(doc.openings, a.opening);
    const w = o && get(doc.walls, o.wall);
    return w && w.level === dim.level ? undefined : 'missing';
  }
  const w = get(doc.walls, a.wall);
  if (!w || w.level !== dim.level) return 'missing';
  if (sagittaOf(w) !== undefined) return 'unmeasurable';
  const line = wallLine(doc, a.wall, a.face);
  if (!line) return 'missing';
  return line.nu[0] * big(dim.direction[0]) + line.nu[1] * big(dim.direction[1]) === 0n ? 'unmeasurable' : undefined;
}

/** An opening's centre (2.2): the midpoint of its start and end points (Core 7.4, 21.6), exactly. */
export function openingCentre(doc: FloorspecDocument, oid: string): { x: Surd; y: Surd } | undefined {
  const o = get(doc.openings, oid);
  const w = o && get(doc.walls, o.wall);
  const s = w && get(doc.junctions, w.start);
  const t = w && get(doc.junctions, w.end);
  const width = o && openingDimensions(doc, o).width;
  if (!o || !s || !t || width === undefined) return undefined;
  const arc = wallArc(doc, o.wall);
  if (arc === 'unfit') return undefined;
  if (arc) {
    const a = pointAt(arc, Q.of(o.offset));
    const b = pointAt(arc, Q.of(big(o.offset) + big(width)));
    return { x: a[0].add(b[0]).div(2n).toSurd(), y: a[1].add(b[1]).div(2n).toSurd() };
  }
  const S = ipoint(s.position);
  const E = ipoint(t.position);
  const e = [E[0] - S[0], E[1] - S[1]] as const;
  const m = e[0] * e[0] + e[1] * e[1];
  // S + e · c / |e| = S + e · c · √m / m, c = offset + width / 2
  const k = Surd.sqrt(m).mulInt(2n * big(o.offset) + big(width)).divInt(2n * m);
  return { x: k.mulInt(e[0]).addInt(S[0]), y: k.mulInt(e[1]).addInt(S[1]) };
}

/** An anchor's position times |d|, `(P − T) · d` — exact; undefined for one that cannot be measured. */
function scaledPosition(doc: FloorspecDocument, dim: DimensionString, a: Anchor): Surd | undefined {
  const d = [big(dim.direction[0]), big(dim.direction[1])] as const;
  const T = ipoint(dim.through);
  const N = d[0] * d[0] + d[1] * d[1];
  if ('wall' in a) {
    const l = wallLine(doc, a.wall, a.face);
    if (!l) return undefined;
    const nd = l.nu[0] * d[0] + l.nu[1] * d[1];
    const nts = l.nu[0] * (T[0] - l.S[0]) + l.nu[1] * (T[1] - l.S[1]);
    const m = l.e[0] * l.e[0] + l.e[1] * l.e[1];
    // t · |d|², t = (λ · √m − ν · (T − S)) / (ν · d)
    return Surd.sqrt(m).mulInt(N * l.lam2).divInt(2n).addInt(-N * nts).divInt(nd);
  }
  let P: { x: Surd; y: Surd } | undefined;
  if ('opening' in a) P = openingCentre(doc, a.opening);
  else {
    const j = 'junction' in a ? get(doc.junctions, a.junction) : undefined;
    const p = 'junction' in a ? j && ipoint(j.position) : ipoint(a.point);
    P = p && { x: Surd.of(p[0]), y: Surd.of(p[1]) };
  }
  return P && P.x.addInt(-T[0]).mulInt(d[0]).add(P.y.addInt(-T[1]).mulInt(d[1]));
}

/** |s' − s| / |d|, rounded once (Core 2.2). */
function gap(s0: Surd, s1: Surd, N: bigint): bigint {
  const diff = s1.sub(s0);
  const v = diff.mul(Surd.sqrt(N)).divInt(N);
  return (diff.sign() < 0 ? v.neg() : v).round();
}

/** A dimension string measured (2.3): its scaled positions, its lengths and total, and whether a segment has no length. */
export interface Measured {
  /** Each anchor's position along the string times |d|, exactly: `p_i · |d|`. */
  readonly scaled: readonly Surd[];
  readonly lengths: readonly bigint[];
  readonly total: bigint;
  /** FS-ANNO-2.3.1: two consecutive anchors at one position, exactly. */
  readonly zeroSegment: boolean;
}

/**
 * Measure a dimension string from a document alone (FS_annotation 2.3), or say why it cannot be:
 * `{ problems }` lists FS-ANNO-LINT-001 and -002 as they apply. A direction of [0, 0] is never
 * measured (FS-ANNO-INV-003).
 */
export function measureDimension(doc: FloorspecDocument, dim: DimensionString): Measured | { problems: AnchorProblem[] } {
  const problems = new Set<AnchorProblem>();
  for (const a of dim.anchors) {
    const p = anchorProblem(doc, dim, a);
    if (p) problems.add(p);
  }
  if (problems.size > 0 || (dim.direction[0] === 0 && dim.direction[1] === 0)) return { problems: [...problems].sort() };
  const scaled = dim.anchors.map((a) => scaledPosition(doc, dim, a));
  if (scaled.some((s) => s === undefined)) return { problems: ['missing'] };
  const s = scaled as Surd[];
  const N = big(dim.direction[0]) ** 2n + big(dim.direction[1]) ** 2n;
  const lengths = s.slice(1).map((x, i) => gap(s[i]!, x, N));
  return { scaled: s, lengths, total: gap(s[0]!, s[s.length - 1]!, N), zeroSegment: s.slice(1).some((x, i) => x.equals(s[i]!)) };
}

const isMeasured = (m: Measured | { problems: AnchorProblem[] }): m is Measured => 'lengths' in m;

// ── the extension ─────────────────────────────────────────────────────────────

function invariants(ctx: ExtensionContext): void {
  const taken = ctx.space();
  for (const id of scenesAndViews(ctx.doc)) taken.add(id);
  const levels = new Set(Object.keys(ctx.doc.levels ?? {}));
  const dims = ctx.records<DimensionString>('dimensions');
  const dimIds = new Set(dims.map(([id]) => id));
  for (const [id, a] of [...dims, ...ctx.records<Note>('notes')] as [string, DimensionString | Note][]) {
    const isNote = 'text' in a;
    if (taken.has(id) || (isNote && dimIds.has(id)))
      ctx.report('FS-ANNO-INV-001', `The ${isNote ? 'note' : 'dimension string'} ID ${id} is also the ID of ${taken.has(id) ? 'an element, a lighting scene or a saved view' : 'a dimension string'}.`, [id], P(isNote ? 'notes' : 'dimensions', id));
    if (!levels.has(a.level)) ctx.report('FS-ANNO-INV-002', `The ${isNote ? 'note' : 'dimension string'} ${id} is drawn on the level ${a.level}, which the document does not have.`, [id], P(isNote ? 'notes' : 'dimensions', id, 'level'));
  }
  for (const [id, d] of dims)
    if (d.direction[0] === 0 && d.direction[1] === 0) ctx.report('FS-ANNO-INV-003', `The dimension string ${id} measures along [0, 0]: no direction at all.`, [id], P('dimensions', id, 'direction'));
}

const label = (id: string, d: DimensionString): string => (d.name === undefined ? id : `${id} (${d.name})`);

function lints(ctx: ExtensionContext): void {
  for (const [id, d] of ctx.records<DimensionString>('dimensions')) {
    const m = measureDimension(ctx.doc, d);
    if (!isMeasured(m)) {
      if (m.problems.includes('missing')) ctx.report('FS-ANNO-LINT-001', `Dimension string ${label(id, d)} measures to a junction, wall or opening that is not on its level ${d.level}: it is not drawn until it is mended.`, [id], P('dimensions', id, 'anchors'));
      if (m.problems.includes('unmeasurable')) ctx.report('FS-ANNO-LINT-002', `Dimension string ${label(id, d)} measures to an arc wall, or to a wall line parallel to its direction, which never crosses it: it is not drawn until it is mended.`, [id], P('dimensions', id, 'anchors'));
    } else if (m.zeroSegment) ctx.report('FS-ANNO-LINT-003', `Dimension string ${label(id, d)} has two consecutive anchors at the same position: a segment of no length.`, [id], P('dimensions', id, 'anchors'));
  }
  const about = ctx.space();
  for (const id of scenesAndViews(ctx.doc)) about.add(id);
  for (const [id] of ctx.records('dimensions')) about.add(id);
  for (const [id, n] of ctx.records<Note>('notes'))
    if (n.about !== undefined && !about.has(n.about)) ctx.report('FS-ANNO-LINT-004', `Note ${id} is about ${n.about}, which the document does not have.`, [id], P('notes', id, 'about'));
}

function derive(ctx: ExtensionContext): DerivedAnnotation {
  return {
    dimensions: record(
      ctx.records<DimensionString>('dimensions').map(([id, d]) => {
        const m = measureDimension(ctx.doc, d);
        return [id, isMeasured(m) ? { level: d.level, lengths: m.lengths.map(toSafeNumber), total: toSafeNumber(m.total) } : { level: d.level, lengths: null, total: null }] as const;
      }),
    ),
    notes: record(ctx.records<Note>('notes').map(([id, n]) => [id, { level: n.level, about: n.about ?? null }] as const)),
  };
}

export const FS_ANNOTATION: ExtensionImplementation<DerivedAnnotation> = {
  name: NAME,
  version: '0.1.0',
  code: 'ANNO',
  catalogue: [
    { code: 'FS-ANNO-SCH-001', severity: 'error', condition: 'the top-level data does not match the schema' },
    { code: 'FS-ANNO-INV-001', severity: 'error', condition: "an annotation's ID is the ID of an element, a program item, an extension element, a scene of FS_lighting or a view of FS_views; or a note's ID is a dimension string's" },
    { code: 'FS-ANNO-INV-002', severity: 'error', condition: "an annotation's `level` names no level of the document" },
    { code: 'FS-ANNO-INV-003', severity: 'error', condition: "a dimension string's `direction` is [0, 0]" },
    { code: 'FS-ANNO-LINT-001', severity: 'warning', condition: 'an anchor of a dimension string names no junction, wall or opening of the document, or one on another level' },
    { code: 'FS-ANNO-LINT-002', severity: 'warning', condition: "a wall anchor of a dimension string names an arc wall, or a wall whose line is parallel to the string's direction" },
    { code: 'FS-ANNO-LINT-003', severity: 'warning', condition: 'a resolved dimension string has two consecutive anchors at the same position' },
    { code: 'FS-ANNO-LINT-004', severity: 'warning', condition: "a note's `about` names nothing in the document's space of IDs, its dimension strings included" },
  ],
  validate: (data) => validateSchema(data),
  invariants,
  lints,
  derive,
};

// ── resolving for drawing ─────────────────────────────────────────────────────

/** One anchor of a resolved dimension string, ready to draw (FS_annotation chapter 4). */
export interface ResolvedAnchor {
  /** Where its extension line starts, on the measured feature: a junction's position, an opening's centre on its wall, the point of a wall's face segment nearest the dimension line's crossing, or a point anchor's point. Rounded to base units. */
  readonly feature: [number, number];
  /** Its point Q_i on the dimension line, where its tick is drawn. Rounded to base units. */
  readonly onLine: [number, number];
  /** Its signed position along the string's unit direction from the first anchor's point, in base units (a float, for drawing). */
  readonly along: number;
}

/** A resolved dimension string: what a renderer draws, with the exact derived lengths. */
export interface ResolvedDimension {
  readonly id: string;
  readonly level: string;
  readonly name: string | null;
  readonly direction: [number, number];
  readonly anchors: readonly ResolvedAnchor[];
  /** Each segment's length, exactly as FS_annotation derives it (6.2). */
  readonly lengths: readonly number[];
  /** The total, first anchor to last, exactly as derived (6.2). */
  readonly total: number;
}

export interface ResolvedNote {
  readonly id: string;
  readonly level: string;
  readonly text: string;
  readonly at: [number, number];
  readonly leader: [number, number] | null;
  readonly about: string | null;
}

export interface ResolvedAnnotations {
  /** Every resolved dimension string, by ID. */
  readonly dimensions: ResolvedDimension[];
  /** Every note, by ID. */
  readonly notes: ResolvedNote[];
  /** The IDs of the dimension strings that cannot be measured (FS-ANNO-LINT-001, -002), or whose data could not be read; never drawn. */
  readonly unresolved: string[];
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isPt = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && isInt(v[0]) && isInt(v[1]);
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
function isAnchor(v: unknown): v is Anchor {
  if (!isObject(v)) return false;
  const k = Object.keys(v);
  if (k.length === 1 && k[0] === 'junction') return isId(v.junction);
  if (k.length === 1 && k[0] === 'opening') return isId(v.opening);
  if (k.length === 1 && k[0] === 'point') return isPt(v.point);
  return k.length === 2 && isId(v.wall) && (v.face === 'left' || v.face === 'right' || v.face === 'location');
}
const isDimension = (v: unknown): v is DimensionString =>
  isObject(v) && isId(v.level) && isPt(v.direction) && isPt(v.through) && Array.isArray(v.anchors) && v.anchors.length >= 2 && v.anchors.every(isAnchor) && (v.name === undefined || typeof v.name === 'string');
const isNote = (v: unknown): v is Note =>
  isObject(v) && isId(v.level) && typeof v.text === 'string' && isPt(v.at) && (v.leader === undefined || isPt(v.leader)) && (v.about === undefined || isId(v.about));

const sortedEntries = (v: unknown): [string, unknown][] => (isObject(v) ? Object.keys(v).sort().map((k) => [k, v[k]]) : []);
const rnd = (x: number, y: number): [number, number] => [Math.round(x), Math.round(y)];

/** The point of segment A–B nearest X, as floats. */
function clampTo(X: readonly [number, number], A: readonly [number, number], B: readonly [number, number]): [number, number] {
  const ux = B[0] - A[0];
  const uy = B[1] - A[1];
  const L = ux * ux + uy * uy;
  const t = L === 0 ? 0 : Math.min(1, Math.max(0, ((X[0] - A[0]) * ux + (X[1] - A[1]) * uy) / L));
  return [A[0] + t * ux, A[1] + t * uy];
}

/**
 * FS_annotation's dimension strings and notes, resolved for drawing: what the editor, the 2D renderer
 * and the PDF draw from, so all three draw one thing. `doc` is the document the derived values belong
 * to — the view of the design being drawn — and `derived` Core's derived values of it (`check()`'s
 * `derived`, or `deriveEvaluation`): the walls' face ends place a face anchor's extension line.
 * Lengths and totals are computed exactly from `doc`, as FS_annotation derives them (2.3, 6.2), so a
 * drawn length is always the derived one. Data that cannot be read is skipped: a dimension string
 * whose record is malformed is listed as unresolved, a malformed note is left out. `level` keeps only
 * that level's annotation.
 */
export function resolveAnnotations(doc: FloorspecDocument, derived: Pick<Derived, 'walls'> | undefined, level?: string): ResolvedAnnotations {
  const data = (doc.extensions as Json | undefined)?.[NAME];
  const out: ResolvedAnnotations = { dimensions: [], notes: [], unresolved: [] };
  if (!isObject(data)) return out;
  for (const [id, raw] of sortedEntries(data.dimensions)) {
    if (level !== undefined && isObject(raw) && raw.level !== level) continue;
    if (!isDimension(raw)) {
      out.unresolved.push(id);
      continue;
    }
    let m: ReturnType<typeof measureDimension>;
    try {
      m = measureDimension(doc, raw);
    } catch {
      m = { problems: ['missing'] };
    }
    if (!isMeasured(m)) {
      out.unresolved.push(id);
      continue;
    }
    const [dx, dy] = raw.direction;
    const N = dx * dx + dy * dy;
    const len = Math.sqrt(N);
    const [tx, ty] = raw.through;
    const s0 = m.scaled[0]!;
    const anchors = raw.anchors.map((a, i): ResolvedAnchor => {
      const s = m.scaled[i]!;
      const k = s.approx() / N; // Q = T + s · d / |d|²
      const Q: [number, number] = [tx + k * dx, ty + k * dy];
      let feature: [number, number];
      if ('point' in a) feature = [a.point[0], a.point[1]];
      else if ('junction' in a) feature = [...get(doc.junctions, a.junction)!.position] as [number, number];
      else if ('opening' in a) {
        const c = openingCentre(doc, a.opening)!;
        feature = [c.x.approx(), c.y.approx()];
      } else {
        const w = get(doc.walls, a.wall)!;
        const dw = derived && isObject(derived.walls) && Object.hasOwn(derived.walls, a.wall) ? derived.walls[a.wall] : undefined;
        const S = get(doc.junctions, w.start)!.position;
        const E = get(doc.junctions, w.end)!.position;
        const seg: [readonly [number, number], readonly [number, number]] | undefined =
          a.face === 'location' ? [S, E] : dw === undefined ? undefined : a.face === 'left' ? [dw.startLeft, dw.endLeft] : [dw.startRight, dw.endRight];
        feature = seg ? clampTo(Q, seg[0], seg[1]) : Q;
      }
      return { feature: rnd(...feature), onLine: rnd(...Q), along: s.sub(s0).approx() / len };
    });
    out.dimensions.push({ id, level: raw.level, name: raw.name ?? null, direction: [dx, dy], anchors, lengths: m.lengths.map(toSafeNumber), total: toSafeNumber(m.total) });
  }
  for (const [id, raw] of sortedEntries(data.notes)) {
    if (!isNote(raw) || (level !== undefined && raw.level !== level)) continue;
    out.notes.push({ id, level: raw.level, text: raw.text, at: [raw.at[0], raw.at[1]], leader: raw.leader ? [raw.leader[0], raw.leader[1]] : null, about: raw.about ?? null });
  }
  return out;
}

/** `resolveAnnotations` for a valid evaluation: its view (the design derived) and Core's derived values of it. */
export function resolveAnnotationsOf(ev: Pick<Evaluation, 'view'>, derived: Pick<Derived, 'walls'> | undefined, level?: string): ResolvedAnnotations {
  return ev.view ? resolveAnnotations(ev.view, derived, level) : { dimensions: [], notes: [], unresolved: [] };
}
