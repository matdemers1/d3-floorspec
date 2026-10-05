import type { EditorModel, LevelView, Place, Point } from './model';
import { labelOf } from './model';
import { dist } from './geometry';
import { formatArea, formatLen, type UnitSystem } from './units';

/**
 * The plan diff (FLR-T-3.5, FLR-T-3.6): two versions of the model, each read and derived by the
 * engine, matched element by element by ID — the IDs are the elements' identity (Core 1.1), so a
 * wall that moved is the same wall in both.
 *
 * - **added**: in the newer version only;
 * - **removed**: in the older only;
 * - **moved**: in both, and the engine derived different geometry for it (a junction's position, a
 *   wall's outline, an opening's jambs, a room's boundary) — drawn as where it was and where it is;
 * - **changed**: in both, the same geometry, a different element (a name, a type, a finish).
 *
 * Nothing here computes geometry: it compares what the engine derived for each version.
 */

export type ChangeKind = 'added' | 'removed' | 'moved' | 'changed';

export interface ElementChange {
  id: string;
  kind: ChangeKind;
  /** Where it is; `adjacency` for a line of the bubble diagram (its ID is `a|b|kind`). */
  collection: Place | 'adjacency' | 'project';
  /** The level the element is on, in the version that has it (the newer when both do). */
  level: string | undefined;
  label: string;
  /** "360 → 408 ft²", "12'-0\" → 13'-0\"", or nothing. */
  detail: string | undefined;
}

export interface ModelDiff {
  changes: ElementChange[];
  counts: Record<ChangeKind, number>;
  /** IDs by kind, for the canvas. */
  ids: Record<ChangeKind, ReadonlySet<string>>;
  /** Whether the two versions are the same document. */
  same: boolean;
}

type Json = Record<string, unknown>;

/** Collections whose elements the diff lists, in the order it lists them: the plan, then the brief and the extensions. */
const LISTED: readonly Place[] = ['buildings', 'levels', 'rooms', 'walls', 'openings', 'separators', 'junctions', 'slabs', 'types', 'materials', 'assets', 'items', 'extension'];
const ORDERED: readonly (Place | 'adjacency' | 'project')[] = [...LISTED, 'adjacency', 'project'];

const ORDER: Record<ChangeKind, number> = { added: 0, removed: 1, moved: 2, changed: 3 };

/** What the engine derived for each element of a version, as a comparable string. */
function geometryOf(model: EditorModel): Map<string, { level: string; sig: string }> {
  const out = new Map<string, { level: string; sig: string }>();
  const p = (pt: Point) => `${String(pt[0])},${String(pt[1])}`;
  const ring = (r: readonly Point[]) => r.map(p).join(' ');
  for (const level of model.levels) {
    for (const j of level.junctions) out.set(j.id, { level: level.id, sig: p(j.position) });
    for (const w of level.walls) out.set(w.id, { level: level.id, sig: `${ring(w.ring)}|${String(w.thickness)}` });
    for (const s of level.separators) out.set(s.id, { level: level.id, sig: `${p(s.a)} ${p(s.b)}` });
    for (const o of level.openings) out.set(o.id, { level: level.id, sig: `${p(o.start)} ${p(o.end)}|${o.wall}` });
    // A room's boundary gains a vertex where a wall now meets it without changing shape: compare
    // the corners that turn, and the area.
    for (const r of level.rooms) out.set(r.id, { level: level.id, sig: `${String(r.area2)}|${corners(r.outer)}|${r.holes.map(corners).join('/')}` });
  }
  return out;
}

/** The vertices of a ring where it turns, sorted: the same shape however its edges are split. */
function corners(ring: readonly Point[]): string {
  const n = ring.length;
  const kept: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = ring[(i + n - 1) % n] as Point;
    const b = ring[i] as Point;
    const c = ring[(i + 1) % n] as Point;
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (cross !== 0) kept.push(`${String(b[0])},${String(b[1])}`);
  }
  return kept.sort().join(' ');
}

const stable = (v: unknown): string => JSON.stringify(v, (_k, value: unknown) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value as Json).sort(([a], [b]) => (a < b ? -1 : 1))) : value));

function elements(model: EditorModel, c: Place): Map<string, Json> {
  if (c === 'items') return new Map(Object.entries((model.document.program?.items ?? {}) as Record<string, Json | undefined>).filter((e): e is [string, Json] => e[1] !== undefined));
  if (c === 'extension') {
    const out = new Map<string, Json>();
    for (const [id, at] of model.ext) {
      const data = (model.document.extensions as Record<string, Json | undefined> | undefined)?.[at.extension];
      const element = ((data?.['collections'] as Record<string, Record<string, Json> | undefined> | undefined)?.[at.collection])?.[id];
      if (element !== undefined) out.set(id, element);
    }
    return out;
  }
  const raw = (model.document as unknown as Json)[c] as Record<string, Json | undefined> | undefined;
  return new Map(Object.entries(raw ?? {}).filter((e): e is [string, Json] => e[1] !== undefined));
}

/** The bubble diagram's lines (Core 0.2, 11.2), keyed by pair and kind, with their weights. */
function adjacencies(model: EditorModel): Map<string, { a: string; b: string; kind: string; weight: number }> {
  const out = new Map<string, { a: string; b: string; kind: string; weight: number }>();
  for (const x of model.document.program?.adjacency ?? []) {
    const [a, b] = x.a < x.b ? [x.a, x.b] : [x.b, x.a];
    out.set(`${a}|${b}|${x.kind}`, { a: x.a, b: x.b, kind: x.kind, weight: x.weight ?? 5 });
  }
  return out;
}

function levelOf(model: EditorModel, id: string, c: Place, element: Json): string | undefined {
  if (c === 'levels') return id;
  if (c === 'items') return undefined;
  if (c === 'extension') {
    const fallback = element['fallback'] as Json | undefined;
    return typeof fallback?.['level'] === 'string' ? fallback['level'] : undefined;
  }
  if (c === 'openings') {
    const wall = model.document.walls?.[String(element['wall'])] as Json | undefined;
    return wall === undefined ? undefined : String(wall['level']);
  }
  return typeof element['level'] === 'string' ? element['level'] : undefined;
}

function findWall(model: EditorModel, id: string): { level: LevelView; a: Point; b: Point } | undefined {
  for (const level of model.levels) {
    const w = level.walls.find((x) => x.id === id) ?? level.separators.find((x) => x.id === id);
    if (w !== undefined) return { level, a: w.a, b: w.b };
  }
  return undefined;
}

function roomArea(model: EditorModel, id: string): bigint | undefined {
  for (const level of model.levels) {
    const r = level.rooms.find((x) => x.id === id);
    if (r !== undefined) return r.area2;
  }
  return undefined;
}

function detailOf(kind: ChangeKind, c: Place, id: string, from: EditorModel, to: EditorModel, units: UnitSystem): string | undefined {
  if (c === 'rooms') {
    const a = roomArea(from, id);
    const b = roomArea(to, id);
    if (kind === 'added' && b !== undefined) return formatArea(b, units);
    if (kind === 'removed' && a !== undefined) return formatArea(a, units);
    if (a !== undefined && b !== undefined && a !== b) return `${formatArea(a, units)} → ${formatArea(b, units)}`;
    return undefined;
  }
  if (c === 'walls' || c === 'separators') {
    const a = findWall(from, id);
    const b = findWall(to, id);
    const len = (w: { a: Point; b: Point }) => formatLen(Math.round(dist(w.a, w.b)), units);
    if (kind === 'added' && b !== undefined) return len(b);
    if (kind === 'removed' && a !== undefined) return len(a);
    if (a !== undefined && b !== undefined) {
      const la = Math.round(dist(a.a, a.b));
      const lb = Math.round(dist(b.a, b.b));
      if (la !== lb) return `${len(a)} → ${len(b)}`;
      // Same length, moved: how far, across.
      const mid = (w: { a: Point; b: Point }): Point => [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2];
      const d = Math.round(dist(mid(a), mid(b)));
      return d > 0 ? `moved ${formatLen(d, units)}` : undefined;
    }
    return undefined;
  }
  if (c === 'junctions' && kind === 'moved') {
    const pa = from.document.junctions?.[id]?.position as Point | undefined;
    const pb = to.document.junctions?.[id]?.position as Point | undefined;
    if (pa !== undefined && pb !== undefined) return `moved ${formatLen(Math.round(dist(pa, pb)), units)}`;
  }
  return undefined;
}

/** Diff two versions of a model. */
export function diffModels(from: EditorModel, to: EditorModel, units: UnitSystem): ModelDiff {
  const changes: ElementChange[] = [];
  const ga = geometryOf(from);
  const gb = geometryOf(to);
  for (const c of LISTED) {
    const a = elements(from, c);
    const b = elements(to, c);
    for (const [id, eb] of b) {
      const ea = a.get(id);
      let kind: ChangeKind | null = null;
      if (ea === undefined) kind = 'added';
      else {
        const geoA = ga.get(id)?.sig;
        const geoB = gb.get(id)?.sig;
        if (geoA !== geoB) kind = 'moved';
        else if (stable(ea) !== stable(eb)) kind = 'changed';
      }
      if (kind === null) continue;
      changes.push({ id, kind, collection: c, level: levelOf(to, id, c, eb), label: labelOf(to, id), detail: detailOf(kind, c, id, from, to, units) });
    }
    for (const [id, ea] of a) {
      if (b.has(id)) continue;
      changes.push({ id, kind: 'removed', collection: c, level: levelOf(from, id, c, ea), label: labelOf(from, id), detail: detailOf('removed', c, id, from, to, units) });
    }
  }
  // A junction that moved because a wall on it moved says nothing the wall does not.
  const walls = new Set(changes.filter((ch) => ch.collection === 'walls' || ch.collection === 'separators').map((ch) => ch.id));
  const onChangedWall = (j: string) =>
    [...walls].some((w) => {
      const e = (to.document.walls?.[w] ?? to.document.separators?.[w] ?? from.document.walls?.[w] ?? from.document.separators?.[w]) as Json | undefined;
      return e?.['start'] === j || e?.['end'] === j;
    });
  const kept = changes.filter((ch) => !(ch.collection === 'junctions' && ch.kind !== 'changed' && onChangedWall(ch.id)));
  // The bubble diagram: a line added, removed or reweighted.
  const ea = adjacencies(from);
  const eb = adjacencies(to);
  const edgeLabel = (m: EditorModel, e: { a: string; b: string; kind: string }) => `${labelOf(m, e.a)} ↔ ${labelOf(m, e.b)} (${e.kind})`;
  for (const [key, e] of eb) {
    const before = ea.get(key);
    if (before === undefined) kept.push({ id: key, kind: 'added', collection: 'adjacency', level: undefined, label: edgeLabel(to, e), detail: undefined });
    else if (before.weight !== e.weight) kept.push({ id: key, kind: 'changed', collection: 'adjacency', level: undefined, label: edgeLabel(to, e), detail: `weight ${String(before.weight)} → ${String(e.weight)}` });
  }
  for (const [key, e] of ea) if (!eb.has(key)) kept.push({ id: key, kind: 'removed', collection: 'adjacency', level: undefined, label: edgeLabel(from, e), detail: undefined });
  const upgraded = from.document.floorspec !== to.document.floorspec;
  const project = upgraded || stable(from.document.project) !== stable(to.document.project) || stable(from.document.extras ?? null) !== stable(to.document.extras ?? null);
  if (project) {
    const detail = upgraded ? `Floorspec ${from.document.floorspec} → ${to.document.floorspec}` : from.document.project.name !== to.document.project.name ? `${from.document.project.name} → ${to.document.project.name}` : undefined;
    kept.push({ id: '$project', kind: 'changed', collection: 'project', level: undefined, label: 'Project settings', detail });
  }
  kept.sort((x, y) => ORDER[x.kind] - ORDER[y.kind] || ORDERED.indexOf(x.collection) - ORDERED.indexOf(y.collection) || (x.id < y.id ? -1 : 1));
  const counts: Record<ChangeKind, number> = { added: 0, removed: 0, moved: 0, changed: 0 };
  const ids: Record<ChangeKind, Set<string>> = { added: new Set(), removed: new Set(), moved: new Set(), changed: new Set() };
  for (const ch of kept) {
    counts[ch.kind] += 1;
    ids[ch.kind].add(ch.id);
  }
  // Moved junctions are still drawn (their walls' outlines carry them), just not listed.
  for (const ch of changes) if (ch.collection === 'junctions') ids[ch.kind].add(ch.id);
  return { changes: kept, counts, ids, same: from.hash === to.hash };
}

/** Group the changes for a list: "Added", "Removed", "Moved", "Changed". */
export function groupChanges(diff: ModelDiff): { kind: ChangeKind; title: string; changes: ElementChange[] }[] {
  const titles: Record<ChangeKind, string> = { added: 'Added', removed: 'Removed', moved: 'Moved or reshaped', changed: 'Changed' };
  return (['added', 'removed', 'moved', 'changed'] as const)
    .map((kind) => ({ kind, title: titles[kind], changes: diff.changes.filter((c) => c.kind === kind) }))
    .filter((g) => g.changes.length > 0);
}

/** Room areas before and after, for the review panel's "Effect". */
export function roomEffects(from: EditorModel, to: EditorModel, units: UnitSystem): { id: string; name: string; before: string | null; after: string | null }[] {
  const names = new Map<string, string>();
  const before = new Map<string, bigint>();
  const after = new Map<string, bigint>();
  for (const l of from.levels) {
    for (const r of l.rooms) {
      names.set(r.id, r.name);
      before.set(r.id, r.area2);
    }
  }
  for (const l of to.levels) {
    for (const r of l.rooms) {
      names.set(r.id, r.name);
      after.set(r.id, r.area2);
    }
  }
  const out: { id: string; name: string; before: string | null; after: string | null }[] = [];
  for (const [id, name] of names) {
    const a = before.get(id);
    const b = after.get(id);
    if (a === b) continue;
    out.push({ id, name, before: a === undefined ? null : formatArea(a, units), after: b === undefined ? null : formatArea(b, units) });
  }
  return out.sort((x, y) => x.name.localeCompare(y.name));
}
