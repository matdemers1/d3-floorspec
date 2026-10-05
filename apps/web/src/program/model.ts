import { parseArea } from '@floorspec/ops';
import { migrationBatch } from '@floorspec/migrate';
import type { EditorModel } from '../editor/model';
import type { Batch } from '../editor/ops';
import type { UnitSystem } from '../editor/units';

/**
 * The brief, read and edited (FLR-T-4.2, Core 0.2 chapter 11). A program's items say what spaces
 * are wanted, how many and how large; its adjacency graph says which should, may or must not be
 * next to each other. Everything the editor shows of how far the plan meets it — each item's rooms,
 * `countMet`, `minAreaMet`, `targetAreaMet`; each adjacency's `adjacent` and `connected` — is the
 * engine's derivation (11.3, 11.4), never computed here. Every edit is a batch of Floorspec Ops
 * (Ops 0.2: addProgramItem, setAdjacency, removeAdjacency, setProperty, removeElement), built by the
 * pure functions below and sent through the editor's one write path.
 */

type Json = Record<string, unknown>;

export type AdjacencyKind = 'required' | 'preferred' | 'forbidden';
export const KINDS: readonly AdjacencyKind[] = ['required', 'preferred', 'forbidden'];
/** Core 0.2, 11.2: an adjacency's weight when it states none. */
export const DEFAULT_WEIGHT = 5;
/** The kind a line drawn between two bubbles starts as: the mildest claim, made stronger in the inspector. */
export const DEFAULT_KIND: AdjacencyKind = 'preferred';

/** Square base units per square foot and per square metre (Core 0.2, 11.1). */
export const SQ_FT = 152_212_340_736;
export const SQ_M = 1_638_400_000_000;
/** The largest area Core allows: 2⁵³ − 1 square base units. */
const MAX_AREA = Number.MAX_SAFE_INTEGER;

/** What an item's NEED badge says: met, or what the plan still lacks. */
export interface Need {
  tone: 'neutral' | 'attention' | 'warning';
  label: string;
  /** The same in a sentence, for the inspector and the badge's accessible name. */
  detail: string;
  met: boolean;
}

export interface ItemRow {
  id: string;
  name: string | undefined;
  /** The name, or a stand-in: "Item P3". */
  label: string;
  function: string;
  count: number;
  targetArea: number | undefined;
  minArea: number | undefined;
  level: string | undefined;
  /** The rooms whose `brief` names it, as the engine derived them; empty when it could not. */
  rooms: string[];
  need: Need;
}

export interface EdgeRow {
  /** `a|b|kind` with the pair sorted: unique, since Core forbids two adjacencies of one pair and kind (11.2.2). */
  key: string;
  a: string;
  b: string;
  kind: AdjacencyKind;
  weight: number;
  /** As derived (11.4); null when the model could not be derived. */
  adjacent: boolean | null;
  connected: boolean | null;
  /** Required and preferred are met when adjacent; forbidden when not (11.4). */
  met: boolean | null;
}

export interface ProgramView {
  /** The document's Floorspec version: a 0.1 plan holds no program until it is upgraded. */
  version: string;
  items: ItemRow[];
  edges: EdgeRow[];
  /** The brief's target area: each item's target times its count, square base units. */
  target: number;
  /** Items whose need is not met, and lines whose kind is not. */
  unmet: { items: number; edges: number };
  /** Whether the engine derived the program (the model is valid). */
  derived: boolean;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/** Item IDs in reading order: P2 before P10. */
export const byId = (a: string, b: string): number => a.localeCompare(b, 'en', { numeric: true });

export function edgeKey(a: string, b: string, kind: AdjacencyKind): string {
  return a < b ? `${a}|${b}|${kind}` : `${b}|${a}|${kind}`;
}

function needOf(count: number, rooms: readonly string[], derived: { countMet: boolean; minAreaMet?: boolean; targetAreaMet?: boolean } | undefined): Need {
  if (derived === undefined) return { tone: 'neutral', label: '—', detail: 'Not derived: the plan does not validate', met: false };
  if (rooms.length === 0) return { tone: 'attention', label: count === 1 ? 'Needs a room' : `Needs ${String(count)}`, detail: count === 1 ? 'No room fulfils it yet' : `No room fulfils it yet; it asks for ${String(count)}`, met: false };
  if (!derived.countMet) return { tone: 'attention', label: `${String(rooms.length)} of ${String(count)}`, detail: `${String(rooms.length)} of the ${String(count)} rooms it asks for`, met: false };
  if (derived.minAreaMet === false) return { tone: 'warning', label: 'Too small', detail: 'A room that fulfils it is below its minimum area', met: false };
  if (derived.targetAreaMet === false) return { tone: 'warning', label: 'Under target', detail: 'A room that fulfils it is smaller than its target area', met: false };
  return { tone: 'neutral', label: 'Met', detail: rooms.length === 1 ? 'Met by one room' : `Met by ${String(rooms.length)} rooms`, met: true };
}

/** Read the brief of a version of the model, with the engine's verdict on each item and line. */
export function readProgram(model: Pick<EditorModel, 'document' | 'derived'>): ProgramView {
  const program = model.document.program;
  const derivedProgram = model.derived?.program;
  const items: ItemRow[] = Object.entries((program?.items ?? {}) as Record<string, Json | undefined>)
    .filter((e): e is [string, Json] => e[1] !== undefined)
    .sort(([a], [b]) => byId(a, b))
    .map(([id, item]) => {
      const name = str(item['name']);
      const count = num(item['count']) ?? 1;
      const d = derivedProgram?.items[id];
      const rooms = d?.rooms ?? [];
      return {
        id,
        name,
        label: name ?? `Item ${id}`,
        function: str(item['function']) ?? 'unspecified',
        count,
        targetArea: num(item['targetArea']),
        minArea: num(item['minArea']),
        level: str(item['level']),
        rooms,
        need: needOf(count, rooms, d),
      };
    });
  const edges: EdgeRow[] = (program?.adjacency ?? []).map((x, i) => {
    const d = derivedProgram?.adjacency[i];
    const kind: AdjacencyKind = x.kind;
    const adjacent = d === undefined ? null : d.adjacent;
    return {
      key: edgeKey(x.a, x.b, kind),
      a: x.a,
      b: x.b,
      kind,
      weight: x.weight ?? DEFAULT_WEIGHT,
      adjacent,
      connected: d === undefined ? null : d.connected,
      met: adjacent === null ? null : kind === 'forbidden' ? !adjacent : adjacent,
    };
  });
  return {
    version: model.document.floorspec,
    items,
    edges,
    target: items.reduce((sum, item) => sum + (item.targetArea ?? 0) * item.count, 0),
    unmet: { items: items.filter((i) => !i.need.met).length, edges: edges.filter((e) => e.met === false).length },
    derived: derivedProgram !== undefined,
  };
}

/** The other end of a line, seen from one item. */
export const otherEnd = (edge: EdgeRow, id: string): string => (edge.a === id ? edge.b : edge.a);

/** Every line between two items, in either order. */
export function edgesBetween(view: ProgramView, a: string, b: string): EdgeRow[] {
  return view.edges.filter((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));
}

// ─── Areas ───────────────────────────────────────────────────────────────────────────────────

/** An area, square base units, as the brief shows it: `140 ft²` or `13.0 m²`. */
export function formatArea(area: number, units: UnitSystem): string {
  if (units === 'metric') return `${(Math.round((area / SQ_M) * 10) / 10).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} m²`;
  return `${Math.round(area / SQ_FT).toLocaleString('en-US')} ft²`;
}

/** The same as an input's value, which parses back: `140 sq ft`, `13 m2`. */
export function areaText(area: number, units: UnitSystem): string {
  if (units === 'metric') return `${String(Math.round((area / SQ_M) * 100) / 100)} m2`;
  return `${String(Math.round((area / SQ_FT) * 10) / 10)} sq ft`;
}

export type AreaInput = { ok: true; value: number } | { ok: false; reason: string };

/**
 * An area as typed, in the Ops area grammar (3.6) — `140 sq ft`, `13 m2`, `12 m²` — parsed by
 * `@floorspec/ops` itself; a bare number is read in the project's display unit, ft² or m².
 */
export function parseAreaInput(text: string, units: UnitSystem): AreaInput {
  const trimmed = text.trim().replace(/\s*(ft²|ft2|sf)$/i, ' sq ft');
  if (trimmed === '') return { ok: false, reason: 'Type an area' };
  const withUnit = /^(\d+(\.\d+)?|\.\d+)$/.test(trimmed) ? `${trimmed} ${units === 'metric' ? 'm2' : 'sq ft'}` : trimmed;
  const parsed = parseArea(withUnit);
  if (!parsed.ok) return { ok: false, reason: `Not an area: ${parsed.reason}` };
  if (parsed.value <= 0n) return { ok: false, reason: 'An area is more than zero' };
  if (parsed.value > BigInt(MAX_AREA)) return { ok: false, reason: 'That area is larger than Floorspec allows' };
  return { ok: true, value: Number(parsed.value) };
}

// ─── Operations ──────────────────────────────────────────────────────────────────────────────

/** What turns a Core 0.1 plan into a 0.3 one — the current draft — that can hold a brief: its migration (Core chapter 20). */
export function upgrade(document: object): Batch {
  return migrationBatch(document, '0.3');
}

export interface NewItem {
  function: string;
  name?: string | undefined;
  count?: number | undefined;
  targetArea?: number | undefined;
  minArea?: number | undefined;
  level?: string | undefined;
}

/** Add a brief item (Ops 0.2, 4.9); its ID is minted by the applier, as `P<n>`. */
export function addItem(item: NewItem): Batch {
  return [
    {
      op: 'addProgramItem',
      function: item.function,
      ...(item.name === undefined || item.name === '' ? {} : { name: item.name }),
      ...(item.count === undefined || item.count === 1 ? {} : { count: item.count }),
      ...(item.targetArea === undefined ? {} : { targetArea: item.targetArea }),
      ...(item.minArea === undefined ? {} : { minArea: item.minArea }),
      ...(item.level === undefined ? {} : { level: item.level }),
    },
  ];
}

export type ItemField = 'name' | 'function' | 'count' | 'targetArea' | 'minArea' | 'level';

/** Set one of an item's members, or unset it — undefined, an empty name, a count of one. */
export function setItem(item: ItemRow, field: ItemField, value: string | number | undefined): Batch {
  const had = field === 'count' ? item.count !== 1 : (field === 'name' ? item.name : field === 'function' ? item.function : item[field]) !== undefined;
  const clear = value === undefined || value === '' || (field === 'count' && value === 1);
  if (clear) return had ? [{ op: 'unsetProperty', id: item.id, path: `/${field}` }] : [];
  return [{ op: 'setProperty', id: item.id, path: `/${field}`, value }];
}

/**
 * Remove an item. Its lines go with it (Ops 0.2); a room that fulfils it would be left naming
 * nothing, which the applier refuses — so those rooms are unlinked in the same batch.
 */
export function removeItem(item: ItemRow): Batch {
  return [...item.rooms.map((room) => ({ op: 'unsetProperty', id: room, path: '/brief' }) as const), { op: 'removeElement', id: item.id }];
}

/** Why two items cannot be related with `kind`, or null when they can (11.2.1, 11.2.3). */
export function relateRefusal(view: ProgramView, a: string, b: string, kind: AdjacencyKind): string | null {
  if (a === b) return 'An item cannot be related to itself.';
  const existing = edgesBetween(view, a, b);
  if (existing.some((e) => e.kind === kind)) return null;
  if (kind === 'forbidden' && existing.length > 0) return 'These two are already wanted together; change that line to forbidden instead.';
  if (kind !== 'forbidden' && existing.some((e) => e.kind === 'forbidden')) return 'These two are forbidden from being next to each other; change that line instead.';
  return null;
}

/** Relate two items: a line of `kind` (Ops 0.2, 2.6 setAdjacency, an upsert by pair and kind). */
export function relate(a: string, b: string, kind: AdjacencyKind = DEFAULT_KIND, weight?: number): Batch {
  return [{ op: 'setAdjacency', a, b, kind, ...(weight === undefined || weight === DEFAULT_WEIGHT ? {} : { weight }) }];
}

/**
 * Change a line's kind: remove it, and set the pair with the new kind and the same weight, in one
 * batch. A pair that already has a line of the new kind keeps that one.
 */
export function setKind(view: ProgramView, edge: EdgeRow, kind: AdjacencyKind): Batch {
  if (kind === edge.kind) return [];
  const others = edgesBetween(view, edge.a, edge.b).filter((e) => e.key !== edge.key);
  const out: Batch = [{ op: 'removeAdjacency', a: edge.a, b: edge.b, kind: edge.kind }];
  // A forbidden line cannot sit beside a wanted one (11.2.3): changing to forbidden drops them too.
  for (const o of others) if ((kind === 'forbidden') !== (o.kind === 'forbidden')) out.push({ op: 'removeAdjacency', a: o.a, b: o.b, kind: o.kind });
  if (!others.some((o) => o.kind === kind)) out.push(...relate(edge.a, edge.b, kind, edge.weight));
  return out;
}

/** Set a line's weight, 1 to 10. Setting the default writes it as the default (canonical form leaves it out). */
export function setWeight(edge: EdgeRow, weight: number): Batch {
  if (weight === edge.weight) return [];
  return [{ op: 'setAdjacency', a: edge.a, b: edge.b, kind: edge.kind, weight }];
}

export function removeEdge(edge: EdgeRow): Batch {
  return [{ op: 'removeAdjacency', a: edge.a, b: edge.b, kind: edge.kind }];
}

/** "Kitchen ↔ Dining". */
export function edgeLabel(view: ProgramView, edge: EdgeRow): string {
  const label = (id: string) => view.items.find((i) => i.id === id)?.label ?? id;
  return `${label(edge.a)} ↔ ${label(edge.b)}`;
}

/** The verdict on a line, in words. */
export function edgeState(edge: EdgeRow): string {
  if (edge.met === null) return 'Not derived: the plan does not validate';
  if (edge.kind === 'forbidden') return edge.adjacent === true ? 'Not met: they share a wall' : 'Met: kept apart';
  if (edge.adjacent !== true) return 'Not met: no room of one is next to a room of the other';
  return edge.connected === true ? 'Met: adjacent, and a door or opening connects them' : 'Met: adjacent (no door between them)';
}

/** Whether a document is a Core 0.1 plan, which holds no brief until it is upgraded (0.2 and 0.3 hold one). */
export const needsUpgrade = (model: EditorModel): boolean => model.document.floorspec === '0.1';

/** The levels an item may prefer, in elevation order. */
export function levelChoices(model: EditorModel): { value: string; label: string }[] {
  return model.levels.map((l) => ({ value: l.id, label: l.name }));
}

export const KIND_LABEL: Record<AdjacencyKind, string> = { required: 'Required', preferred: 'Preferred', forbidden: 'Forbidden' };
