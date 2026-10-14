import type { EditorStore } from '../store';
import type { EditorModel, LevelView } from '../model';
import { labelOf } from '../model';
import { dist } from '../geometry';
import type { Snap } from '../snap';
import { BASE_PER_FOOT } from '../units';
import { precisionOf, type Measure, type MeasurePoint } from './state';

/**
 * The measure tool (FLR-T-18.9, ⇧M): a tape, after SketchUp's. Click from point to point — each one
 * snapped as a wall would be, faces and items included — and the chain grows; click its first point
 * again and it closes on an area. Double-click or Enter ends it; Esc clears it. It measures and
 * never edits: keeping a measurement as a dimension belongs to FLR-T-18.11, which registers itself
 * on the precision store (`keepAsDimension`).
 */

export interface Segment {
  from: MeasurePoint;
  to: MeasurePoint;
  length: number;
  /** "Cooktop → sink", or "A → B" for points that snapped to nothing named. */
  label: string;
}

export interface MeasureSummary {
  segments: Segment[];
  total: number;
  /** Twice the enclosed area, exact to the base unit², when the chain is closed. */
  area2: bigint | null;
  /** The kitchen work triangle (sink, refrigerator, cooktop), when the closed chain is one. */
  triangle: { total: number; over: boolean } | null;
}

/** The kitchen work triangle's sum of sides, as the NKBA guideline puts it: 26 feet. */
export const WORK_TRIANGLE = 26 * BASE_PER_FOOT;

/** "Sink" reads as "sink" after an arrow, as the board's "Cooktop → sink"; "A", "W12" and "X4" stay. */
const lowerFirst = (n: string): string => (/^[A-Z][a-z]/.test(n) ? n.charAt(0).toLowerCase() + n.slice(1) : n);

const letter = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : `P${String(i + 1)}`);

/** What a point is called in the panel: the item or wall it snapped to, or a letter. */
export function pointName(p: MeasurePoint, i: number): string {
  return p.label ?? letter(i);
}

export function summarize(m: Pick<Measure, 'points' | 'closed'>, kinds?: (ref: string) => 'sink' | 'fridge' | 'cooktop' | null): MeasureSummary {
  const pts = m.points;
  const segments: Segment[] = [];
  const n = pts.length;
  const pairs = m.closed ? n : n - 1;
  for (let i = 0; i < pairs; i++) {
    const a = pts[i] as MeasurePoint;
    const b = pts[(i + 1) % n] as MeasurePoint;
    const an = pointName(a, i);
    const bn = pointName(b, (i + 1) % n);
    segments.push({ from: a, to: b, length: dist(a.point, b.point), label: `${an} → ${lowerFirst(bn)}` });
  }
  const total = segments.reduce((t, s) => t + s.length, 0);
  let area2: bigint | null = null;
  if (m.closed && n >= 3) {
    let twice = 0;
    for (let i = 0; i < n; i++) {
      const a = (pts[i] as MeasurePoint).point;
      const b = (pts[(i + 1) % n] as MeasurePoint).point;
      twice += a[0] * b[1] - b[0] * a[1];
    }
    area2 = BigInt(Math.round(Math.abs(twice)));
  }
  let triangle: MeasureSummary['triangle'] = null;
  if (m.closed && n === 3 && kinds !== undefined) {
    const found = new Set(pts.map((p) => (p.ref === undefined ? null : kinds(p.ref))));
    if (found.has('sink') && found.has('fridge') && found.has('cooktop')) triangle = { total, over: total > WORK_TRIANGLE };
  }
  return { segments, total, area2, triangle };
}

/** Which corner of the work triangle an element is, by its kind and its catalogue words. */
export function triangleKind(model: EditorModel, level: LevelView | undefined, ref: string): 'sink' | 'fridge' | 'cooktop' | null {
  const d = level?.devices.find((x) => x.id === ref);
  const words = [d?.kind?.id, d?.kindLabel, d?.element['catalogue'], d?.element['category'], d?.element['name'], labelOf(model, ref)].filter((w): w is string => typeof w === 'string').join(' ').toLowerCase();
  if (/sink/.test(words)) return 'sink';
  if (/fridge|refrigerator/.test(words)) return 'fridge';
  if (/cooktop|range|stove|oven|hob/.test(words)) return 'cooktop';
  return null;
}

/** A snap as a measure point: named by what it snapped to. */
function pointOf(store: EditorStore, snap: Snap): MeasurePoint {
  const model = store.get().model;
  if (snap.ref === undefined || snap.ref.startsWith('~') || model === null) return { point: snap.point };
  // Its name without the size: "Cooktop", not "Cooktop, 760 mm" — the panel is narrow.
  return { point: snap.point, ref: snap.ref, label: labelOf(model, snap.ref).split(', ')[0] ?? snap.ref };
}

/** The pointer moved with the measure tool: where the next point would go. */
export function measureMove(store: EditorStore, snap: Snap): void {
  const p = precisionOf(store);
  p.set({ measure: { ...p.get().measure, cursor: snap } });
}

/** A click with the measure tool: a point added, the chain closed on its first, or a new chain begun. */
export function measureClick(store: EditorStore, snap: Snap, detail: number): void {
  const p = precisionOf(store);
  const m = p.get().measure;
  const finished = m.closed || m.done === true;
  const points = finished ? [] : m.points;
  const last = points[points.length - 1];
  const at = pointOf(store, snap);
  if (last !== undefined && last.point[0] === at.point[0] && last.point[1] === at.point[1]) {
    // The same point again: a double click ends the chain.
    if (detail >= 2 && points.length >= 2) p.set({ measure: { ...m, done: true, cursor: null } });
    return;
  }
  const first = points[0];
  if (first !== undefined && points.length >= 3 && first.point[0] === at.point[0] && first.point[1] === at.point[1]) {
    p.set({ measure: { points, cursor: null, closed: true, done: true } });
    return;
  }
  p.set({ measure: { points: [...points, at], cursor: snap, closed: false, done: false } });
}

/** Enter: end the chain where it is. */
export function measureEnd(store: EditorStore): boolean {
  const p = precisionOf(store);
  const m = p.get().measure;
  if (m.points.length < 2 || m.done === true) return false;
  p.set({ measure: { ...m, done: true, cursor: null } });
  return true;
}

/** Backspace: take the last point back. */
export function measureBack(store: EditorStore): boolean {
  const p = precisionOf(store);
  const m = p.get().measure;
  if (m.points.length === 0) return false;
  p.set({ measure: { ...m, points: m.points.slice(0, -1), closed: false, done: false } });
  return true;
}

export { dist };
