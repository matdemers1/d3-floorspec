import type { CustomDimension } from '@floorspec/render2d';
import type { EditorStore } from '../store';
import type { Batch } from '../ops';
import type { EditorModel, LevelView, Point } from '../model';
import { cross, dist, dot, sub } from '../geometry';
import type { Snap } from '../snap';
import type { MeasurePoint } from '../precision/state';
import { addDimension, addNote, anchorOf, directionOf, type DimensionRecord } from './ops';
import { annotateOf, EMPTY_DIMENSION, type DimensionDraft, type DraftAnchor } from './state';

/**
 * The dimension and note tools (FLR-T-18.11), after Revit's aligned dimension: click what to measure —
 * a junction, a wall's face or its location line, a door or window's centre, or a point — then click
 * where the string goes (Enter places it at the pointer); each anchor is kept as a reference, so the
 * string follows its walls. A note is a click where its text goes, or a drag from what it points at
 * to where its text goes, then its text.
 */

/** What the pointer is over, as an anchor: a door or window's centre first, then what the snap found. */
export function anchorAt(level: LevelView, world: Point, tol: number, snap: Snap): DraftAnchor {
  let best: { id: string; point: Point; d: number } | null = null;
  for (const o of level.openings) {
    if (o.kind === 'opening') continue;
    const c: Point = [(o.start[0] + o.end[0]) / 2, (o.start[1] + o.end[1]) / 2];
    const d = dist(c, world);
    if (d <= tol * 1.5 && (best === null || d < best.d)) best = { id: o.id, point: c, d };
  }
  if (best !== null) return { kind: 'opening', id: best.id, point: best.point };
  if (snap.kind === 'junction' && snap.ref !== undefined && !snap.ref.startsWith('~')) return { kind: 'junction', id: snap.ref, point: snap.point };
  if ((snap.kind === 'face' || snap.kind === 'wall') && snap.ref !== undefined) {
    const w = level.walls.find((x) => x.id === snap.ref);
    if (w !== undefined && w.arc === undefined) {
      const along = sub(w.b, w.a);
      const face = snap.kind === 'wall' ? 'axis' : cross(along, sub(snap.point, w.a)) > 0 ? 'left' : 'right';
      return { kind: 'wall', id: w.id, face, point: snap.point, along };
    }
  }
  return { kind: 'point', point: snap.point };
}

/** The direction a string measures along: across a wall it measures to, else level, plumb, or along its anchors. */
export function draftDirection(anchors: readonly DraftAnchor[]): Point {
  const wall = anchors.find((a): a is Extract<DraftAnchor, { kind: 'wall' }> => a.kind === 'wall');
  if (wall !== undefined) {
    const [x, y] = wall.along;
    return Math.abs(x) >= Math.abs(y) * 20 ? [0, 1] : Math.abs(y) >= Math.abs(x) * 20 ? [1, 0] : [-y, x];
  }
  const first = anchors[0]?.point;
  const last = anchors[anchors.length - 1]?.point;
  if (first === undefined || last === undefined) return [1, 0];
  const d = sub(last, first);
  if (Math.abs(d[0]) >= Math.abs(d[1]) * 3) return [1, 0];
  if (Math.abs(d[1]) >= Math.abs(d[0]) * 3) return [0, 1];
  return d;
}

/** A draft as a string to draw: its anchors projected onto the line through `through`. */
export function draftString(anchors: readonly DraftAnchor[], through: Point, id = 'draft'): CustomDimension | null {
  if (anchors.length < 2) return null;
  const d = draftDirection(anchors);
  const l = Math.hypot(d[0], d[1]);
  const u: Point = [d[0] / l, d[1] / l];
  const onLine = (p: Point): Point => {
    const t = dot(sub(p, through), u);
    return [through[0] + u[0] * t, through[1] + u[1] * t];
  };
  const pts = anchors.map((a) => ({ feature: a.point, onLine: onLine(a.point) }));
  const lengths = pts.slice(1).map((p, i) => Math.round(Math.abs(dot(sub(p.onLine, pts[i]?.onLine ?? p.onLine), u))));
  return { id, direction: d, anchors: pts, lengths };
}

export function dimensionMove(store: EditorStore, anchor: DraftAnchor, world: Point): void {
  const a = annotateOf(store);
  a.set({ dimension: { ...a.get().dimension, hover: anchor, cursor: world } });
}

/** A click with the dimension tool: an anchor added, or — over nothing to measure, with two or more — the string placed. */
export function dimensionDown(store: EditorStore, anchor: DraftAnchor, world: Point): void {
  const a = annotateOf(store);
  const d = a.get().dimension;
  if (d.anchors.length >= 2 && (anchor.kind === 'point' || d.placing)) {
    void placeDimension(store, d, world);
    return;
  }
  const last = d.anchors[d.anchors.length - 1];
  if (last !== undefined && sameAnchor(last, anchor)) {
    // The same anchor again (a double click): place the string at the pointer.
    if (d.anchors.length >= 2) a.set({ dimension: { ...d, placing: true } });
    return;
  }
  a.set({ dimension: { anchors: [...d.anchors, anchor], hover: anchor, cursor: world, placing: false } });
}

function sameAnchor(p: DraftAnchor, q: DraftAnchor): boolean {
  if (p.kind !== q.kind) return false;
  if (p.kind === 'point' || q.kind === 'point') return p.point[0] === q.point[0] && p.point[1] === q.point[1];
  return p.id === (q as { id: string }).id && (p.kind !== 'wall' || p.face === (q as { face: string }).face);
}

/** Enter: place the string at the pointer. */
export function dimensionEnter(store: EditorStore): boolean {
  const d = annotateOf(store).get().dimension;
  if (d.anchors.length < 2 || d.cursor === null) return false;
  void placeDimension(store, d, d.cursor);
  return true;
}

/** Backspace: take the last anchor back. */
export function dimensionBack(store: EditorStore): boolean {
  const a = annotateOf(store);
  const d = a.get().dimension;
  if (d.anchors.length === 0) return false;
  a.set({ dimension: { ...d, anchors: d.anchors.slice(0, -1), placing: false } });
  return true;
}

async function placeDimension(store: EditorStore, d: DimensionDraft, through: Point): Promise<void> {
  const s = store.get();
  const model = s.model;
  if (model === null || s.level === null) return;
  const level = s.level;
  const record: DimensionRecord = { level, direction: directionOf(draftDirection(d.anchors)), through: [Math.round(through[0]), Math.round(through[1])], anchors: d.anchors.map(anchorOf) };
  annotateOf(store).set({ dimension: EMPTY_DIMENSION });
  let id = '';
  const ok = await store.apply('Add a dimension', (attempt) => {
    const made = addDimension(store.get().model ?? model, record, attempt);
    id = made.id;
    return made.batch;
  });
  if (ok) annotateOf(store).select(id);
}

// ── notes ──

export function noteDown(store: EditorStore, world: Point): void {
  annotateOf(store).set({ note: { tip: world, at: null, text: '', cursor: world } });
}

export function noteMove(store: EditorStore, world: Point): void {
  const a = annotateOf(store);
  const n = a.get().note;
  if (n !== null && n.at === null) a.set({ note: { ...n, cursor: world } });
}

/** Lifted: a drag drew a leader from where it began; a click is a note without one. Then its text. */
export function noteUp(store: EditorStore, world: Point, moved: boolean): void {
  const a = annotateOf(store);
  const n = a.get().note;
  if (n === null || n.at !== null) return;
  a.set({ note: moved && n.tip !== null ? { tip: n.tip, at: world, text: '', cursor: null } : { tip: null, at: n.tip ?? world, text: '', cursor: null } });
}

export async function commitNote(store: EditorStore, text: string): Promise<void> {
  const a = annotateOf(store);
  const n = a.get().note;
  const s = store.get();
  a.set({ note: null });
  const model = s.model;
  const t = text.trim();
  if (n === null || n.at === null || model === null || s.level === null || t === '') return;
  const at: [number, number] = [Math.round(n.at[0]), Math.round(n.at[1])];
  const record = { level: s.level, text: t.slice(0, 500), at, ...(n.tip === null ? {} : { leader: [Math.round(n.tip[0]), Math.round(n.tip[1])] as [number, number] }) };
  let id = '';
  const ok = await store.apply('Add a note', (attempt) => {
    const made = addNote(store.get().model ?? model, record, attempt);
    id = made.id;
    return made.batch;
  });
  if (ok) a.select(id);
}

// ── the measure tool's "Keep as a dimension" (FLR-T-18.9's hook) ──

/** A measure point as an anchor: the junction or wall it snapped to, else the point. */
function measureAnchor(level: LevelView | undefined, m: MeasurePoint): DraftAnchor {
  if (m.ref !== undefined && level !== undefined) {
    const j = level.junctions.find((x) => x.id === m.ref);
    if (j !== undefined && j.position[0] === m.point[0] && j.position[1] === m.point[1]) return { kind: 'junction', id: j.id, point: m.point };
  }
  return { kind: 'point', point: m.point };
}

/**
 * Keep a measurement as dimensions: a chain along one line as one string, offset a little from what
 * it measures; any other chain as a string per side, each along its own side.
 */
export async function keepAsDimension(store: EditorStore, points: readonly MeasurePoint[], closed = false): Promise<void> {
  const s = store.get();
  const model: EditorModel | null = s.model;
  const view = s.view;
  if (model === null || s.level === null || view === null || points.length < 2) return;
  const level = store.levelView;
  const anchors = points.map((p) => measureAnchor(level, p));
  const first = anchors[0]?.point ?? [0, 0];
  const last = anchors[anchors.length - 1]?.point ?? first;
  const along = sub(last, first);
  const l = Math.hypot(along[0], along[1]) || 1;
  const off = 24 / view.s;
  const straight = !closed && anchors.every((a) => Math.abs(cross(along, sub(a.point, first))) / l <= 2 / view.s);
  const sides: DraftAnchor[][] = straight
    ? [anchors]
    : anchors.map((a, i) => [a, anchors[(i + 1) % anchors.length] ?? a]).slice(0, closed ? anchors.length : anchors.length - 1);
  const records: DimensionRecord[] = sides.map((pair) => {
    const p = pair[0]?.point ?? first;
    const q = pair[pair.length - 1]?.point ?? last;
    const d = sub(q, p);
    const n = Math.hypot(d[0], d[1]) || 1;
    const through: Point = [p[0] - (d[1] / n) * off, p[1] + (d[0] / n) * off];
    return { level: s.level as string, direction: directionOf(d), through: [Math.round(through[0]), Math.round(through[1])], anchors: pair.map(anchorOf) };
  });
  let ids: string[] = [];
  const ok = await store.apply(records.length === 1 ? 'Keep the measurement as a dimension' : `Keep the measurement as ${String(records.length)} dimensions`, (attempt) => {
    const m = store.get().model ?? model;
    const batch: Batch = [];
    ids = [];
    records.forEach((r, i) => {
      // IDs past the last in use, one each; the declaration with the first.
      const made = addDimension(m, r, attempt * records.length + i);
      ids.push(made.id);
      batch.push(...(i === 0 ? made.batch : made.batch.slice(-1)));
    });
    return batch;
  });
  if (ok && ids[0] !== undefined) annotateOf(store).select(ids[0]);
}
