/**
 * Measuring a candidate. The final measures come from the real engine, on the document the
 * candidate's batch actually commits:
 *
 * 1. the batch — which sets each placed room's `brief` (Ops 0.2) — is applied with @floorspec/ops
 *    to the document the solver lays out into, so every candidate is a batch that commits, or it
 *    is dropped;
 * 2. the committed document is checked with @floorspec/engine: the program's derived values (11.3,
 *    11.4: countMet, minAreaMet, targetAreaMet, adjacent) and every diagnostic, lints included,
 *    are the engine's own;
 * 3. a **probe view** — the same result with a synthetic program of one item per room and a
 *    preferred adjacency between every pair — gives the engine's `adjacent` and `connected` (11.4)
 *    for every pair of rooms: the circulation graph, as the engine sees the doors and separators.
 *
 * The probe view is a measurement only; nothing writes it anywhere.
 *
 * Before any of that, every variant gets a quick estimate from its rectangles alone (`estimate`),
 * so that only the most promising few are applied and checked in full.
 */
import { check, type Diagnostic } from '@floorspec/engine';
import { apply, type Operation } from '@floorspec/ops';
import type { Access } from './access.js';
import { plannedPairs } from './access.js';
import { collection, type Json } from './document.js';
import { between, isExterior, pairKey, rh, rw, type Layout, type Seg, type Space } from './layout.js';
import type { Adjacency, Brief } from './program.js';
import { BU_PER_FOOT, SQ_BU_PER_SQ_FT } from './units.js';

export interface RoomMeasure {
  /** Net area, square feet. */
  readonly area: number;
  /** Plan extent of the room polygon, feet. */
  readonly w: number;
  readonly h: number;
}

export interface ItemMeasure {
  /** Space keys of the item's rooms on this layout. */
  readonly rooms: readonly string[];
  readonly countMet: boolean;
  readonly minAreaMet?: boolean;
  readonly targetAreaMet?: boolean;
}

export interface AdjacencyMeasure {
  readonly a: string;
  readonly b: string;
  readonly kind: Adjacency['kind'];
  readonly weight: number;
  readonly adjacent: boolean;
}

export interface Measures {
  readonly source: 'estimate' | 'engine';
  readonly rooms: ReadonlyMap<string, RoomMeasure>;
  readonly items: Readonly<Record<string, ItemMeasure>>;
  readonly adjacency: readonly AdjacencyMeasure[];
  /** Pairs of space keys whose rooms are adjacent / connected (pairKey). */
  readonly adjacent: ReadonlySet<string>;
  readonly connected: ReadonlySet<string>;
  /** Diagnostics of the committed document, without the program lints FS-LINT-008…011 (which brief fit already counts). */
  readonly findings: readonly Diagnostic[];
  /** Every diagnostic of the committed document. */
  readonly diagnostics: readonly Diagnostic[];
}

const PROGRAM_LINTS = new Set(['FS-LINT-008', 'FS-LINT-009', 'FS-LINT-010', 'FS-LINT-011']);

/** Half the thickness each kind of edge takes from a room beside it, in feet. */
const TAKE = { exterior: 7.25 / 12, interior: 2.25 / 12, separator: 0 };

/** The quick estimate: net areas from rectangles less their walls, adjacency and connection as planned. */
export function estimate(layout: Layout, segs: readonly Seg[], access: Access, brief: Brief): Measures {
  const rooms = new Map<string, RoomMeasure>();
  for (const s of layout.spaces) {
    const take = (pick: (seg: Seg) => boolean): number => {
      let t = 0;
      for (const seg of segs.filter(pick)) t = Math.max(t, isExterior(seg) ? TAKE.exterior : access.separators.has(seg) ? TAKE.separator : TAKE.interior);
      return t;
    };
    const r = s.rect;
    const onSide = (seg: Seg, horizontal: boolean, at: number): boolean =>
      seg.horizontal === horizontal && (seg.left === s.key || seg.right === s.key) && (horizontal ? seg.a[1] === at : seg.a[0] === at);
    const w = rw(r) / 2 - take((g) => onSide(g, false, r.x0)) - take((g) => onSide(g, false, r.x1));
    const h = rh(r) / 2 - take((g) => onSide(g, true, r.y0)) - take((g) => onSide(g, true, r.y1));
    rooms.set(s.key, { area: w * h, w, h });
  }
  const adjacent = new Set<string>();
  for (const seg of segs) if (seg.left !== undefined && seg.right !== undefined) adjacent.add(pairKey(seg.left, seg.right));
  return finish('estimate', layout, brief, rooms, adjacent, plannedPairs(access), []);
}

function finish(
  source: Measures['source'],
  layout: Layout,
  brief: Brief,
  rooms: ReadonlyMap<string, RoomMeasure>,
  adjacent: ReadonlySet<string>,
  connected: ReadonlySet<string>,
  diagnostics: readonly Diagnostic[],
  engineItems?: Readonly<Record<string, ItemMeasure>>,
  engineAdjacency?: readonly AdjacencyMeasure[],
): Measures {
  const roomsOf = new Map<string, string[]>();
  for (const s of layout.spaces) if (s.req !== undefined) roomsOf.set(s.req.item, [...(roomsOf.get(s.req.item) ?? []), s.key]);
  const items: Record<string, ItemMeasure> = {};
  for (const [id, item] of Object.entries(brief.items)) {
    const rs = roomsOf.get(id) ?? [];
    const area = (k: string): number => rooms.get(k)?.area ?? 0;
    items[id] = engineItems?.[id] ?? {
      rooms: rs,
      countMet: rs.length >= (item.count ?? 1),
      ...(item.minArea === undefined ? {} : { minAreaMet: rs.every((k) => area(k) * SQ_BU_PER_SQ_FT >= item.minArea!) }),
      ...(item.targetArea === undefined ? {} : { targetAreaMet: rs.every((k) => area(k) * SQ_BU_PER_SQ_FT >= item.targetArea!) }),
    };
  }
  const adjacency =
    engineAdjacency ??
    brief.adjacency.map((x) => ({
      a: x.a,
      b: x.b,
      kind: x.kind,
      weight: x.weight ?? 5,
      adjacent: (roomsOf.get(x.a) ?? []).some((p) => (roomsOf.get(x.b) ?? []).some((q) => p !== q && adjacent.has(pairKey(p, q)))),
    }));
  return {
    source,
    rooms,
    items,
    adjacency,
    adjacent,
    connected,
    findings: diagnostics.filter((d) => !PROGRAM_LINTS.has(d.code) && d.severity !== 'error'),
    diagnostics,
  };
}

export type Applied =
  | { readonly status: 'committed'; readonly document: string; readonly measures: Measures }
  | { readonly status: 'rejected'; readonly stage: 'apply' | 'check' | 'probe'; readonly diagnostics: readonly Diagnostic[] };

/** The probe view: one synthetic item per room on the level, every pair a preferred adjacency. */
function probeView(committed: Json, roomIds: readonly string[]): Json {
  const view = structuredClone(committed);
  // A program needs Core 0.2 or later: a 0.1 document is read as 0.2, a later one keeps its version.
  if (view['floorspec'] === '0.1') view['floorspec'] = '0.2';
  const rooms = collection(view, 'rooms');
  // The rooms' own briefs name the real program's items, which the probe's program replaces.
  for (const room of Object.values(rooms)) delete room['brief'];
  const items: Record<string, unknown> = {};
  for (const id of roomIds) {
    items[`probe-${id}`] = { function: rooms[id]!['function'] ?? 'unspecified' };
    rooms[id]!['brief'] = `probe-${id}`;
  }
  const adjacency: unknown[] = [];
  for (let i = 0; i < roomIds.length; i++)
    for (let j = i + 1; j < roomIds.length; j++) adjacency.push({ a: `probe-${roomIds[i]!}`, b: `probe-${roomIds[j]!}`, kind: 'preferred' });
  view['program'] = { items, adjacency };
  return view;
}

/** Apply a candidate batch to the document and measure the result with the engine. */
export function measure(
  document: Json,
  batch: readonly Operation[],
  retired: readonly string[],
  layout: Layout,
  roomIds: ReadonlyMap<string, string>,
  brief: Brief,
): Applied {
  const result = apply(document, { batch: [...batch], ...(retired.length > 0 ? { context: { retired: [...retired] } } : {}) });
  if (result.status === 'rejected') return { status: 'rejected', stage: 'apply', diagnostics: result.diagnostics };
  const committed = JSON.parse(result.document) as Json;
  const keyOf = new Map([...roomIds].map(([k, id]) => [id, k]));

  const view = check(committed);
  if (!view.valid || view.derived === undefined) return { status: 'rejected', stage: 'check', diagnostics: view.diagnostics };
  const ours = [...roomIds.values()];
  const probe = check(probeView(committed, ours));
  if (!probe.valid || probe.derived?.program === undefined) return { status: 'rejected', stage: 'probe', diagnostics: probe.diagnostics };

  const rooms = new Map<string, RoomMeasure>();
  for (const [id, poly] of Object.entries(view.derived.rooms)) {
    const k = keyOf.get(id);
    if (k === undefined) continue;
    const xs = poly.outer.map((p) => p[0]);
    const ys = poly.outer.map((p) => p[1]);
    rooms.set(k, {
      area: Number(poly.area) / SQ_BU_PER_SQ_FT,
      w: (Math.max(...xs) - Math.min(...xs)) / BU_PER_FOOT,
      h: (Math.max(...ys) - Math.min(...ys)) / BU_PER_FOOT,
    });
  }
  const adjacent = new Set<string>();
  const connected = new Set<string>();
  for (const a of probe.derived.program.adjacency) {
    const p = keyOf.get(a.a.slice('probe-'.length))!;
    const q = keyOf.get(a.b.slice('probe-'.length))!;
    if (a.adjacent) adjacent.add(pairKey(p, q));
    if (a.connected) connected.add(pairKey(p, q));
  }
  // The program's derived values, in space keys.
  const derived = view.derived.program;
  const items: Record<string, ItemMeasure> = {};
  for (const [id, v] of Object.entries(derived?.items ?? {}))
    items[id] = {
      rooms: v.rooms.map((r) => keyOf.get(r) ?? r),
      countMet: v.countMet,
      ...(v.minAreaMet === undefined ? {} : { minAreaMet: v.minAreaMet }),
      ...(v.targetAreaMet === undefined ? {} : { targetAreaMet: v.targetAreaMet }),
    };
  const adjacency = (derived?.adjacency ?? []).map((a, i) => ({ a: a.a, b: a.b, kind: a.kind, weight: brief.adjacency[i]?.weight ?? 5, adjacent: a.adjacent }));
  return {
    status: 'committed',
    document: result.document,
    measures: finish('engine', layout, brief, rooms, adjacent, connected, view.diagnostics, items, adjacency),
  };
}

/** Whether two spaces share an edge in the layout (for explanations). */
export const touches = (segs: readonly Seg[], p: Space, q: Space): boolean => between(segs, p.key, q.key).length > 0;
