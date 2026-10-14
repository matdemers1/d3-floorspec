import { OFFICIAL_READER } from '@floorspec/engine';
import { resolveBatch, type Operation } from '@floorspec/ops';
import { elementOf, kindOf, labelOf, type EditorModel, type LevelView, type Point, type Ring } from '../editor/model';
import { addOpening, moveJunction, setProperty, typeChoices, type Batch, type BatchBuilder, type TypeChoice } from '../editor/ops';
import { centroid, dist, faceAt, roomsBeside } from '../editor/geometry';
import { nudgeBatch, type Arrow } from '../editor/nudge';
import { carryRiders } from '../editor/arrange/carry';
import { extentAcross, resizeRoom, roomFace, roomSides } from '../editor/rooms/edit';
import { moveDevice, type HostRef } from '../editor/systems/ops';
import type { DeviceView } from '../editor/systems/view';
import { formatLen, gridStep, prettyLen, type UnitSystem } from '../editor/units';
import { boxOf, frameVectors, isResizable, middleOf, resizeBatch, ruleFor, sizeOf, type Axis as BoxAxis } from '../furniture/resize';
import { entriesFor, search, type Entry } from '../placing/catalog';
import { ghostOf, type Ghost } from '../placing/ghost';
import { CAN_DO, parsePhrase, type Axis, type Dir, type Intent } from './grammar';

/**
 * Say it on the plan (FLR-T-18.15): an intent from the grammar made into an Ops batch against the
 * model, offline and deterministic. Each element a phrase names is found by its ID, its name, what
 * it is (an island, a door, a wall), the room it is in, the selection ("it", "this") or an ordinal —
 * and walls by Ops' own selectors ("north wall of Pantry", "wall between Kitchen and Pantry", Ops
 * 3.3), resolved by the reference applier itself. Several elements that fit are never chosen
 * between silently: the outcome is a question with the candidates, and the answer (a pick) is fed
 * back in. What the plan does not let a click pick — a trade mode's ghosts, what a renovation plan
 * hides — is not found either, unless nothing else is.
 *
 * Every change is built by the editor's existing op builders — nudgeBatch (moveElement, moveRoom,
 * moveWall, moveOpening, moveJunction), resizeBatch (resizeElement), resizeRoom, addOpening,
 * setProperty, setRoomFinish — and a placement is the quick-add bar's ghost, placed as it places.
 */

export interface PhraseContext {
  model: EditorModel;
  /** The level being edited. */
  level: string | null;
  /** The selection, primary last. */
  selected: readonly string[];
  units: UnitSystem;
  /** One nudge, for "nudge it north". */
  nudgeStep: number;
  /** The level as a click picks from it (modes.ts `pickable`, renovation.tsx `pickableUnder`). */
  pickable: (level: LevelView) => LevelView;
  /** Where a placement with no place named goes: the pointer, else the middle of the view. */
  at: Point | null;
}

export interface Choice {
  value: string;
  label: string;
  detail?: string;
  /** Elements to light up on the plan while this choice is highlighted. */
  highlight: string[];
  /** Why it cannot be chosen, when it cannot. */
  disabled?: string;
}

export type Outcome =
  | {
      status: 'ready';
      /** "Move Kitchen island 6″ north". */
      summary: string;
      /** The history's label. */
      label: string;
      /** The edit, as Ops; absent for a placement, which the placing ghost makes. */
      batch?: Batch | BatchBuilder;
      place?: { entry: Entry; ghost: Ghost };
      /** What the edit acts on, outlined on the plan. */
      targets: string[];
      /** What to select once it lands; null to leave the selection. */
      select: string | null;
      /** Select the opening the batch makes, by the ID the server gives it. */
      selectNew?: boolean;
      level: string;
      /** Said beside the summary: what else it does. */
      notes: string[];
    }
  | { status: 'choose'; key: string; question: string; options: Choice[] }
  | { status: 'fail'; message: string };

type Json = Record<string, unknown>;
type Picks = Readonly<Record<string, string>>;

/** A question raised while resolving: thrown, caught by `interpret`. */
class Ask extends Error {
  constructor(readonly outcome: Outcome) {
    super('ask');
  }
}
const fail = (message: string): never => {
  throw new Ask({ status: 'fail', message });
};
const ask = (key: string, question: string, options: Choice[]): never => {
  throw new Ask({ status: 'choose', key, question, options });
};

/** A length as the card reads it: 6″, 3′-6″, 900 mm. */
export function lenText(v: number, units: UnitSystem): string {
  return prettyLen(v, units).replace(/"/g, '″').replace(/'/g, '′');
}

/** An element's short name: "Kitchen island", not "Kitchen island, 1800 mm". */
export function shortName(model: EditorModel, id: string): string {
  const l = labelOf(model, id);
  return kindOf(model, id) === 'extensionElement' ? (l.split(',')[0] ?? l) : l;
}

// ─── What a phrase can name ──────────────────────────────────────────────────────────────────

type ElementKind = 'room' | 'wall' | 'separator' | 'opening' | 'item' | 'junction' | 'level';

interface Described {
  id: string;
  kind: ElementKind;
  level: string;
  /** The name, folded: "kitchen island". */
  name: string;
  /** What it is: "island", "door", "wall", "room". */
  nouns: string[];
  /** Every word that may name it: its name's, its nouns', its rooms'. */
  bag: Set<string>;
  /** The rooms it is in or beside. */
  rooms: string[];
}

const fold = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9'\- ]+/g, ' ').replace(/\s+/g, ' ').trim();
const singular = (w: string) => (w.length > 3 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && /(ch|sh|x)es$/.test(w) ? w.slice(0, -2) : w.length > 2 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const wordsOf = (s: string) => fold(s).split(/[\s-]+/).filter((w) => w !== '').map(singular);
const camelWords = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

/** The words a room function goes by (Core 6.3), so "the living room" finds the Great room. */
const FUNCTION_WORDS: Readonly<Record<string, string[]>> = {
  living: ['living', 'lounge', 'family', 'sitting'],
  kitchen: ['kitchen'],
  dining: ['dining'],
  sleeping: ['bedroom', 'bed'],
  bath: ['bathroom', 'bath', 'washroom', 'wc', 'toilet'],
  office: ['office', 'study', 'den'],
  laundry: ['laundry', 'utility', 'mudroom'],
  garage: ['garage'],
  storage: ['storage', 'closet', 'pantry', 'store'],
  circulation: ['hall', 'hallway', 'corridor', 'entry', 'landing'],
  exterior: ['deck', 'patio', 'terrace', 'porch', 'balcony'],
};

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Everything on a level a phrase can name, with the words that name it. */
function describe(model: EditorModel, level: LevelView): Described[] {
  const out: Described[] = [];
  const roomName = (id: string | null) => (id === null ? [] : [id]);
  const roomWords = (ids: string[]) => ids.flatMap((r) => wordsOf(labelOf(model, r)));
  const push = (id: string, kind: ElementKind, name: string, nouns: string[], rooms: string[]) => {
    const n = fold(name);
    out.push({ id, kind, level: level.id, name: n, nouns, rooms, bag: new Set([...wordsOf(name), ...nouns.flatMap(wordsOf), ...roomWords(rooms), id.toLowerCase()]) });
  };
  for (const r of level.rooms) {
    const fn = (model.document.rooms as Record<string, Json | undefined> | undefined)?.[r.id]?.['function'];
    push(r.id, 'room', labelOf(model, r.id), ['room', ...(typeof fn === 'string' ? (FUNCTION_WORDS[fn] ?? [fn]) : [])], []);
  }
  for (const w of level.walls) {
    const beside = roomsBeside(level, w.id);
    push(w.id, 'wall', labelOf(model, w.id), ['wall'], [...roomName(beside.left), ...roomName(beside.right)]);
  }
  for (const s of level.separators) {
    const beside = roomsBeside(level, s.id);
    push(s.id, 'separator', labelOf(model, s.id), ['separator'], [...roomName(beside.left), ...roomName(beside.right)]);
  }
  for (const o of level.openings) {
    const beside = roomsBeside(level, o.wall);
    push(o.id, 'opening', labelOf(model, o.id), o.kind === 'opening' ? ['opening', 'doorway'] : [o.kind], [...roomName(beside.left), ...roomName(beside.right)]);
  }
  for (const d of level.devices) {
    const host = d.host;
    const room = host !== null && typeof host['room'] === 'string' ? host['room'] : d.placement === null ? null : (faceAt(level, d.placement.point)?.room ?? null);
    const category = typeof d.element['category'] === 'string' ? camelWords(d.element['category']) : '';
    const nouns = [d.kindLabel.toLowerCase(), category].filter((w) => w !== '');
    push(d.id, 'item', shortName(model, d.id), nouns, roomName(room));
  }
  for (const j of level.junctions) push(j.id, 'junction', labelOf(model, j.id), ['junction', 'corner'], []);
  return out;
}

/** The levels, as things a phrase can rename. */
function describeLevels(model: EditorModel): Described[] {
  return model.levels.map((l) => ({ id: l.id, kind: 'level' as const, level: l.id, name: fold(l.name), nouns: ['level', 'floor', 'storey'], rooms: [], bag: new Set([...wordsOf(l.name), 'level', 'floor', l.id.toLowerCase()]) }));
}

const DETERMINERS = /^(?:the|a|an|this|that|my|our|its|their)\s+/;
const ORDINALS: Readonly<Record<string, number>> = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5, last: -1 };
const PRONOUN = /^(?:it|this|that|this one|that one|them|selection|the selection|selected|the selected(?: \w+)?|selected \w+|what is selected|what's selected)$/;

/** IDs in the order the project tree lists them: W2 before W10. */
const byId = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

interface Ref {
  /** The phrase as said, for messages. */
  said: string;
  /** Which kinds it may be. */
  kinds: readonly ElementKind[];
  /** A word for the kinds, for messages: "an item, a room, a wall or an opening". */
  what: string;
  /** The key its question and pick go under. */
  key: string;
}

/** The level views to search: the current one first, then the others. */
function levelsOf(ctx: PhraseContext): LevelView[] {
  const current = ctx.model.levels.find((l) => l.id === ctx.level);
  return [...(current === undefined ? [] : [current]), ...ctx.model.levels.filter((l) => l.id !== ctx.level)];
}

/** A Choice for an element: its name, what it is, where. */
function choiceOf(ctx: PhraseContext, d: Described | string, extra?: string): Choice {
  const id = typeof d === 'string' ? d : d.id;
  const model = ctx.model;
  const kind = kindOf(model, id);
  const level = model.levels.find((l) => l.id === (typeof d === 'string' ? undefined : d.level));
  const rooms = typeof d === 'string' ? [] : d.rooms.map((r) => labelOf(model, r));
  const what = kind === 'extensionElement' ? (model.levels.flatMap((l) => l.devices).find((x) => x.id === id)?.kindLabel ?? 'Item') : kind === null ? '' : `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
  const parts = [what, rooms.length > 0 ? rooms.join(' · ') : null, level !== undefined && level.id !== ctx.level ? level.name : null, id, extra ?? null].filter((x): x is string => x !== null && x !== '');
  return { value: id, label: shortName(model, id), detail: parts.join(' · '), highlight: [id] };
}

/**
 * Resolve the words naming one element. Returns its ID; asks when several fit and none was picked;
 * fails when nothing does.
 */
function resolveRef(ctx: PhraseContext, ref: Ref, picks: Picks): string {
  const model = ctx.model;
  let said = fold(ref.said).replace(DETERMINERS, '').trim();
  if (said === '') return fail(`Say what to change: ${ref.what}.`);
  const picked = picks[ref.key];
  const accepts = (id: string): boolean => {
    const k = kindOf(model, id);
    const mapped: ElementKind | null = k === 'extensionElement' ? 'item' : k === 'room' || k === 'wall' || k === 'separator' || k === 'opening' || k === 'junction' || k === 'level' ? k : null;
    return mapped !== null && ref.kinds.includes(mapped);
  };
  // "it", "this", "the selected": the selection.
  if (PRONOUN.test(said)) {
    const sel = ctx.selected.filter(accepts);
    if (sel.length === 0) return fail(ctx.selected.length === 0 ? `Nothing is selected. Select ${ref.what.split(',')[0] ?? 'it'} first, or name it.` : `What is selected is not ${ref.what}.`);
    if (sel.length === 1) return sel[0] as string;
    if (picked !== undefined && sel.includes(picked)) return picked;
    return ask(ref.key, `Which of the selected?`, sel.map((id) => choiceOf(ctx, id)));
  }
  // An ID, bare or after its kind: "W12", "wall W12", "door O3".
  const idWord = said.replace(/^(?:wall|door|window|opening|room|item|junction|separator|level)\s+/, '');
  for (const id of model.index.keys()) if (id.toLowerCase() === idWord && accepts(id)) return id;
  // An Ops selector for a wall or separator (Ops 3.3).
  const wallSel = wallSelector(ctx, said, ref, picks);
  if (wallSel !== null) return wallSel.id;

  // An ordinal: "the second window in the kitchen".
  let ordinal: number | null = null;
  const ord = /^(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last)\s+(.+)$/.exec(said);
  if (ord !== null) {
    ordinal = ORDINALS[ord[1] ?? ''] ?? null;
    said = ord[2] ?? said;
  }
  // "the sofa in the den": a room that qualifies it.
  let roomFilter: string[] | null = null;
  const inRoom = /^(.+?)\s+(?:in|of|on|inside|from|by)\s+(?:the\s+)?(.+)$/.exec(said);
  let noun = said;
  if (inRoom !== null) {
    const rooms = findRooms(ctx, inRoom[2] ?? '');
    if (rooms.length > 0) {
      roomFilter = rooms.map((r) => r.id);
      noun = inRoom[1] ?? said;
    }
  }
  const words = wordsOf(noun);
  const levels = levelsOf(ctx);
  for (const [pass, level] of levels.entries()) {
    // The current level, as the plan picks from it; then all of it (a ghost is still there to name);
    // then the other levels.
    const views = pass === 0 ? [ctx.pickable(level), level] : [level];
    for (const view of views) {
      let found = match(describe(model, view), noun, words).filter((d) => ref.kinds.includes(d.kind));
      const within = roomFilter;
      if (within !== null) found = found.filter((d) => d.rooms.some((r) => within.includes(r)));
      if (found.length === 0) continue;
      const ids = found.map((d) => d.id).sort(byId);
      if (ordinal !== null) {
        const id = ordinal === -1 ? ids[ids.length - 1] : ids[ordinal - 1];
        if (id === undefined) return fail(`There are only ${String(ids.length)} ${noun} here.`);
        return id;
      }
      if (ids.length === 1) return ids[0] as string;
      if (picked !== undefined && ids.includes(picked)) return picked;
      const sorted = [...found].sort((a, b) => byId(a.id, b.id));
      return ask(ref.key, `Which ${noun}?`, sorted.slice(0, 12).map((d) => choiceOf(ctx, d)));
    }
  }
  const where = levels[0]?.name ?? 'this level';
  return fail(`I can’t find “${ref.said}” on ${where}. Name it as the tree does — a room, an item, a wall like W12 — or select it and say “it”.`);
}

/** The descriptions that fit a noun phrase best: by name, then by what they are, then by every word. */
function match(all: Described[], noun: string, words: string[]): Described[] {
  if (words.length === 0) return [];
  const n = fold(noun);
  const exact = all.filter((d) => d.name === n || d.name === `the ${n}`);
  if (exact.length > 0) return exact;
  const nameWords = (d: Described) => new Set(wordsOf(d.name));
  const byName = all.filter((d) => words.every((w) => nameWords(d).has(w)));
  const byNoun = all.filter((d) => d.nouns.some((x) => fold(x) === n || wordsOf(x).join(' ') === words.join(' ')));
  // What it is before what its name says: "the sofa" is each sofa, not the throw over a sofa's arm.
  if (byNoun.length > 0) return byNoun;
  if (byName.length > 0) return byName;
  // Every word somewhere — its name, what it is, its room: "the den sofa". What it is by the last
  // word first: the den's sofa, not the throw over its arm.
  const loose = all.filter((d) => words.every((w) => d.bag.has(w)));
  const head = words[words.length - 1] ?? '';
  const headed = loose.filter((d) => d.nouns.some((x) => wordsOf(x).includes(head)));
  return headed.length > 0 ? headed : loose;
}

/** The rooms some words name, on the level being edited first: by name, then by function. */
function findRooms(ctx: PhraseContext, said: string): Described[] {
  const noun = fold(said).replace(DETERMINERS, '').replace(/\s+room$/, (m) => (said.toLowerCase().includes('living room') || said.toLowerCase().includes('family room') ? '' : m)).trim();
  if (noun === '') return [];
  for (const level of levelsOf(ctx)) {
    const rooms = describe(ctx.model, level).filter((d) => d.kind === 'room');
    const id = rooms.find((r) => r.id.toLowerCase() === noun);
    if (id !== undefined) return [id];
    const words = wordsOf(noun).filter((w) => w !== 'room' || noun === 'room');
    const exact = rooms.filter((r) => r.name === noun || r.name === fold(said));
    if (exact.length > 0) return exact;
    const byName = rooms.filter((r) => words.length > 0 && words.every((w) => new Set(wordsOf(r.name)).has(w)));
    if (byName.length > 0) return byName;
    const byFunction = rooms.filter((r) => words.length > 0 && words.every((w) => r.nouns.includes(w)));
    if (byFunction.length > 0) return byFunction;
  }
  return [];
}

/** One room the words name, or a question, or a failure. */
function resolveRoom(ctx: PhraseContext, said: string, key: string, picks: Picks): string {
  const rooms = findRooms(ctx, said);
  if (rooms.length === 0) return fail(`I can’t find a room called “${said}”.`);
  if (rooms.length === 1) return (rooms[0] as Described).id;
  const picked = picks[key];
  if (picked !== undefined && rooms.some((r) => r.id === picked)) return picked;
  return ask(key, `Which ${said.replace(DETERMINERS, '')}?`, rooms.map((r) => choiceOf(ctx, r)));
}

const SIDES: readonly Dir[] = ['north', 'east', 'south', 'west'];

/**
 * What an Ops selector resolves to, by the reference applier itself (Ops 3.3) — one ID, or several
 * (FS-OPS-004 names them), or none. Rooms are passed by ID, so the room's words are this resolver's.
 */
export function selectWalls(document: EditorModel['document'], selector: string): string[] {
  const probe = resolveBatch(document, { batch: [{ op: 'setProperty', id: selector, path: '/extras/d3floorspec/probe', value: true }] }, OFFICIAL_READER);
  if (probe.status === 'resolved') {
    const p = probe.resolved[0];
    return p !== undefined && 'id' in p ? [p.id] : [];
  }
  const many = probe.diagnostics.find((d) => d.code === 'FS-OPS-004');
  return many === undefined ? [] : [...((many as unknown as { elements?: string[] }).elements ?? [])];
}

/**
 * "the north wall of the pantry", "the pantry's north wall", "the wall between the kitchen and the
 * pantry": the Ops selector it is, resolved. Null when the words are not one of these forms.
 */
function wallSelector(ctx: PhraseContext, said: string, ref: Ref, picks: Picks): { id: string; selector: string | null } | null {
  if (!ref.kinds.includes('wall') && !ref.kinds.includes('separator')) return null;
  const side = /^(north|south|east|west)(?:ern)?\s+(wall|separator)\s+(?:of|in|on)\s+(?:the\s+)?(.+)$/.exec(said) ?? (() => {
    const m = /^(.+?)'s?\s+(north|south|east|west)(?:ern)?\s+(wall|separator)$/.exec(said);
    return m === null ? null : [m[0], m[2], m[3], m[1]];
  })();
  if (side !== null) {
    const room = resolveRoom(ctx, side[3] ?? '', `${ref.key}:room`, picks);
    const selector = `${side[1] ?? 'north'} ${side[2] ?? 'wall'} of ${room}`;
    const ids = selectWalls(ctx.model.document, selector);
    if (ids.length === 0) return fail(`${labelOf(ctx.model, room)} has no ${side[1] ?? ''} ${side[2] ?? 'wall'}.`);
    if (ids.length === 1) return { id: ids[0] as string, selector };
    const picked = picks[ref.key];
    if (picked !== undefined && ids.includes(picked)) return { id: picked, selector: null };
    return ask(ref.key, `${labelOf(ctx.model, room)} has ${String(ids.length)} ${side[1] ?? ''} walls. Which?`, ids.map((id) => choiceOf(ctx, id, lenOfWall(ctx, id))));
  }
  const between = /^(?:(wall|separator)\s+)?between\s+(?:the\s+)?(.+?)\s+and\s+(?:the\s+)?(.+)$/.exec(said);
  if (between !== null) {
    const a = resolveRoom(ctx, between[2] ?? '', `${ref.key}:a`, picks);
    const b = resolveRoom(ctx, between[3] ?? '', `${ref.key}:b`, picks);
    const edge = between[1] ?? 'wall';
    const selector = `${edge} between ${a} and ${b}`;
    const ids = selectWalls(ctx.model.document, selector);
    if (ids.length === 0) return fail(`${labelOf(ctx.model, a)} and ${labelOf(ctx.model, b)} share no ${edge}.`);
    if (ids.length === 1) return { id: ids[0] as string, selector };
    const picked = picks[ref.key];
    if (picked !== undefined && ids.includes(picked)) return { id: picked, selector: null };
    return ask(ref.key, `${labelOf(ctx.model, a)} and ${labelOf(ctx.model, b)} share ${String(ids.length)} walls. Which?`, ids.map((id) => choiceOf(ctx, id, lenOfWall(ctx, id))));
  }
  return null;
}

function wallView(ctx: PhraseContext, id: string) {
  for (const l of ctx.model.levels) {
    const w = l.walls.find((x) => x.id === id);
    if (w !== undefined) return { wall: w, level: l };
  }
  return null;
}

const wallLength = (w: { a: Point; b: Point; arc?: { length: number } }) => w.arc?.length ?? dist(w.a, w.b);
const lenOfWall = (ctx: PhraseContext, id: string): string => {
  const w = wallView(ctx, id);
  return w === null ? '' : `${lenText(Math.round(wallLength(w.wall)), ctx.units)} long`;
};

const levelOf = (ctx: PhraseContext, id: string): LevelView => {
  for (const l of ctx.model.levels) {
    if (l.rooms.some((r) => r.id === id) || l.walls.some((w) => w.id === id) || l.openings.some((o) => o.id === id) || l.devices.some((d) => d.id === id) || l.junctions.some((j) => j.id === id) || l.separators.some((s) => s.id === id) || l.id === id) return l;
  }
  return fail(`${id} is on no level.`);
};

const deviceOf = (level: LevelView, id: string): DeviceView | undefined => level.devices.find((d) => d.id === id);

// ─── The intents ─────────────────────────────────────────────────────────────────────────────

const ARROW: Readonly<Record<Dir, Arrow>> = { north: 'ArrowUp', south: 'ArrowDown', east: 'ArrowRight', west: 'ArrowLeft' };
const UNIT: Readonly<Record<Dir, Point>> = { north: [0, 1], south: [0, -1], east: [1, 0], west: [-1, 0] };

const MOVABLE: readonly ElementKind[] = ['item', 'room', 'wall', 'opening', 'junction', 'separator'];
const MOVABLE_WHAT = 'an item, a room, a wall, an opening or a junction';

/** Move an item on a floor or free by a vector, to the base unit. */
function shiftDevice(d: DeviceView, by: Point): Batch | null {
  const host = d.host;
  if (host === null || (host['mode'] !== 'surface' && host['mode'] !== 'free')) return null;
  const p = host['position'];
  if (!Array.isArray(p) || typeof p[0] !== 'number' || typeof p[1] !== 'number') return null;
  const at: [number, number] = [Math.round(p[0] + by[0]), Math.round(p[1] + by[1])];
  const rotation = typeof host['rotation'] === 'number' ? host['rotation'] : 0;
  const next: HostRef = host['mode'] === 'surface' ? { mode: 'surface', room: String(host['room']), surface: host['surface'] === 'ceiling' ? 'ceiling' : 'floor', at, rotation } : { mode: 'free', level: String(host['level']), at, rotation };
  return moveDevice(d.id, next);
}

/** The room an item stands in. */
function roomOfDevice(level: LevelView, d: DeviceView): string | null {
  if (d.host !== null && typeof d.host['room'] === 'string') return d.host['room'];
  return d.placement === null ? null : (faceAt(level, d.placement.point)?.room ?? null);
}

function moveIntent(ctx: PhraseContext, intent: Extract<Intent, { verb: 'move' }>, picks: Picks): Outcome {
  const model = ctx.model;
  const id = resolveRef(ctx, { said: intent.ref, kinds: MOVABLE, what: MOVABLE_WHAT, key: 'target' }, picks);
  const level = levelOf(ctx, id);
  const name = shortName(model, id);
  const kind = kindOf(model, id);
  const ready = (summary: string, batch: Batch, notes: string[] = []): Outcome => ({ status: 'ready', summary, label: summary, batch, targets: [id], select: id, level: level.id, notes });
  if (intent.by !== undefined) {
    const distance = intent.by.distance ?? (intent.nudge ? ctx.nudgeStep : null);
    if (distance === null) return fail(`How far? “move ${intent.ref} 6 inches ${intent.by.dir}”.`);
    const batch = nudgeBatch(level, model.document, id, ARROW[intent.by.dir], distance);
    if (batch === null) {
      if (kind === 'wall') return fail(`${name} runs ${runsOf(level, id)}: a wall moves sideways, across itself. Try east or west — or north or south — whichever crosses it.`);
      if (kind === 'opening') return fail(`${name} moves along its wall: say a direction along it.`);
      if (kind === 'extensionElement') return fail(`${name} is on a wall face and moves along its wall: say a direction along it.`);
      return fail(`${name} does not move that way.`);
    }
    return ready(`Move ${name} ${lenText(distance, ctx.units)} ${intent.by.dir}`, batch);
  }
  const to = intent.to;
  if (to === undefined) return fail('Say how far and which way.');
  if (to.kind === 'point') {
    if (kind === 'junction') return ready(`Move ${name} to ${formatLen(to.point[0], ctx.units)}, ${formatLen(to.point[1], ctx.units)}`, moveJunction(id, to.point));
    const d = deviceOf(level, id);
    const mid = d === undefined ? null : middleOf(d);
    const batch = d === undefined || mid === null ? null : shiftDevice(d, [to.point[0] - mid[0], to.point[1] - mid[1]]);
    if (batch === null) return fail(`A point is for an item on a floor or a junction; move ${name} by a distance instead.`);
    return ready(`Move ${name} to ${formatLen(to.point[0], ctx.units)}, ${formatLen(to.point[1], ctx.units)}`, batch);
  }
  const d = deviceOf(level, id);
  if (d === undefined || boxOf(d.element) === null) return fail(`Only an item moves ${to.kind === 'wall' ? 'against a wall' : 'to the middle of its room'}; move ${name} by a distance instead.`);
  const room = roomOfDevice(level, d);
  const face = room === null ? undefined : roomFace(level, room);
  if (room === null || face === undefined) return fail(`${name} is not in a room.`);
  const footprint = d.footprint;
  if (to.kind === 'centre') {
    const mid = middleOf(d);
    const c = centroid(face.outer);
    if (mid === null) return fail(`${name} has no footprint to centre.`);
    const batch = shiftDevice(d, [c[0] - mid[0], c[1] - mid[1]]);
    if (batch === null) return fail(`${name} is on a wall face; it moves along its wall.`);
    return ready(`Move ${name} to the middle of ${labelOf(model, room)}`, batch);
  }
  const u = UNIT[to.side];
  const reach = (ring: Ring) => Math.max(...ring.map((p) => p[0] * u[0] + p[1] * u[1]));
  // A sixteenth short of the face: an item's host point stands strictly inside its room (FS-INV-503).
  const by = Math.round(reach(face.outer) - reach(footprint)) - SHY;
  if (Math.abs(by) < SHY) return fail(`${name} is already against the ${to.side} wall of ${labelOf(model, room)}.`);
  const batch = nudgeBatch(level, model.document, id, ARROW[to.side], by) ?? (by < 0 ? nudgeBatch(level, model.document, id, ARROW[opposite(to.side)], -by) : null);
  if (batch === null) return fail(`${name} does not move that way.`);
  return ready(`Move ${name} ${lenText(Math.abs(by), ctx.units)} ${by >= 0 ? to.side : opposite(to.side)}, against the ${to.side} wall of ${labelOf(model, room)}`, batch);
}

/** How far short of a wall's face "against" stops: 1/16″. */
const SHY = 2_032;

const opposite = (d: Dir): Dir => (d === 'north' ? 'south' : d === 'south' ? 'north' : d === 'east' ? 'west' : 'east');

function runsOf(level: LevelView, id: string): string {
  const w = level.walls.find((x) => x.id === id);
  if (w === undefined) return '';
  return Math.abs(w.b[0] - w.a[0]) > Math.abs(w.b[1] - w.a[1]) ? 'east–west' : 'north–south';
}

const RESIZABLE: readonly ElementKind[] = ['item', 'opening', 'room'];

function resizeIntent(ctx: PhraseContext, intent: Extract<Intent, { verb: 'resize' }>, picks: Picks): Outcome {
  const model = ctx.model;
  const id = resolveRef(ctx, { said: intent.ref, kinds: RESIZABLE, what: 'an item, an opening or a room', key: 'target' }, picks);
  const level = levelOf(ctx, id);
  const name = shortName(model, id);
  const kind = kindOf(model, id);
  const ready = (summary: string, batch: Batch): Outcome => ({ status: 'ready', summary, label: summary, batch, targets: [id], select: id, level: level.id, notes: [] });
  const changeText = (c: { axis: Axis; mode: 'to' | 'by'; value: number }) => (c.mode === 'to' ? `${lenText(c.value, ctx.units)} ${AXIS_ADJ[c.axis]}` : `${lenText(Math.abs(c.value), ctx.units)} ${c.value > 0 ? MORE[c.axis] : LESS[c.axis]}`);
  if (kind === 'extensionElement') {
    const d = deviceOf(level, id);
    const box = d === undefined ? null : boxOf(d.element);
    if (d === undefined || box === null || !isResizable(d)) return fail(`${name} is not something I can resize.`);
    const size = sizeOf(box);
    const rule = ruleFor(d);
    const next: Partial<Record<BoxAxis, number>> = {};
    for (const c of intent.changes) {
      // An item's length is its longer side: an island's or a sofa's width (FS_furniture 3.1).
      const axis: BoxAxis = c.axis === 'length' ? (size.width >= size.depth ? 'width' : 'depth') : c.axis;
      const v = c.mode === 'to' ? c.value : size[axis] + c.value;
      if (v <= 0) return fail(`${name} would be no ${AXIS_ADJ[c.axis]} at all.`);
      const lim = rule.limits[axis];
      if ((lim?.min !== undefined && v < lim.min) || (lim?.max !== undefined && v > lim.max)) return fail(`${name} comes ${lim.min === undefined ? '' : `from ${lenText(lim.min, ctx.units)} `}${lim.max === undefined ? '' : `to ${lenText(lim.max, ctx.units)} `}${axis === 'height' ? 'tall' : axis === 'depth' ? 'deep' : 'wide'}.`);
      next[axis] = v;
    }
    return ready(`Resize ${name} ${intent.changes.map(changeText).join(' and ')}`, resizeBatch(id, 'center', next, rule));
  }
  if (kind === 'opening') {
    const o = level.openings.find((x) => x.id === id);
    const host = o === undefined ? undefined : level.walls.find((w) => w.id === o.wall);
    if (o === undefined || host === undefined) return fail(`${name} is in no wall I can read.`);
    const batch: Batch = [];
    const parts: string[] = [];
    for (const c of intent.changes) {
      if (c.axis === 'depth') return fail(`An opening is as deep as its wall; say wide or tall.`);
      if (c.axis === 'height') {
        const el = elementOf(model, id) ?? {};
        const now = typeof el['height'] === 'number' ? el['height'] : null;
        const v = c.mode === 'to' ? c.value : (now ?? 0) + c.value;
        if (c.mode === 'by' && now === null) return fail(`${name} takes its height from its type; say the height it should be: “make ${intent.ref} 7 feet tall”.`);
        batch.push(...setProperty(id, '/height', v));
        parts.push(changeText(c));
        continue;
      }
      const w = c.mode === 'to' ? c.value : o.width + c.value;
      const L = wallLength(host);
      if (w <= 0 || w > L) return fail(`${lenText(w, ctx.units)} does not fit in ${labelOf(model, host.id)}, which is ${lenText(Math.round(L), ctx.units)} long.`);
      // Its middle stays where it is.
      const offset = Math.max(0, Math.min(Math.round(L - w), Math.round(o.offset - (w - o.width) / 2)));
      batch.push(...setProperty(id, '/width', w));
      if (offset !== o.offset) batch.push(...setProperty(id, '/offset', offset));
      parts.push(changeText({ ...c, axis: 'width' }));
    }
    return ready(`Resize ${name} ${parts.join(' and ')}`, batch);
  }
  // A room: one side moves (Ops 4.4).
  if (intent.changes.length !== 1) return fail('Resize a room one side at a time: “extend the pantry 2 feet east”.');
  const c = intent.changes[0] as { axis: Axis; mode: 'to' | 'by'; value: number };
  if (c.axis === 'height') return fail('A room’s height is its level’s.');
  const sides = roomSides(level, id).filter((s) => s.ok);
  const wanted: readonly Dir[] = c.axis === 'width' ? ['east', 'west'] : c.axis === 'depth' ? ['north', 'south'] : SIDES;
  let side = intent.side;
  if (side === undefined) {
    const options = SIDES.filter((s) => wanted.includes(s)).map((s): Choice => {
      const rs = roomSides(level, id).find((x) => x.side === s);
      return { value: s, label: `The ${s} side`, detail: rs === undefined ? 'no straight side' : rs.ok ? `moves ${s === 'north' || s === 'south' ? 'north–south' : 'east–west'}` : `cannot move: it ${rs.why ?? 'is jogged'}`, highlight: [id], ...(rs?.ok === true ? {} : { disabled: 'This side cannot move' }) };
    });
    const picked = picks['side'];
    if (picked !== undefined && SIDES.includes(picked as Dir)) side = picked as Dir;
    else return ask('side', `Which side of ${name} moves?`, options);
  }
  if (!sides.some((s) => s.side === side)) return fail(`The ${side} side of ${name} cannot move: it is not one straight run of edges.`);
  const across = extentAcross(level, id, side);
  const by = c.mode === 'to' ? c.value - across : c.value;
  if (by === 0) return fail(`${name} is already ${lenText(across, ctx.units)} across.`);
  if (across + by <= 0) return fail(`${name} would have no room left.`);
  return ready(`Resize ${name}: its ${side} side ${by > 0 ? 'out' : 'in'} ${lenText(Math.abs(by), ctx.units)}`, resizeRoom(id, side, by));
}

const AXIS_ADJ: Readonly<Record<Axis, string>> = { length: 'long', width: 'wide', depth: 'deep', height: 'tall' };
const MORE: Readonly<Record<Axis, string>> = { length: 'longer', width: 'wider', depth: 'deeper', height: 'taller' };
const LESS: Readonly<Record<Axis, string>> = { length: 'shorter', width: 'narrower', depth: 'shallower', height: 'lower' };

/** Free stretches of a wall, between the openings already in it. */
function freeSpans(level: LevelView, wall: string, L: number, skip: string | null = null): [number, number][] {
  const taken = level.openings.filter((o) => o.wall === wall && o.id !== skip).map((o) => [o.offset, o.offset + o.width] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  let at = 0;
  for (const [a, b] of taken) {
    if (a > at) out.push([at, a]);
    at = Math.max(at, b);
  }
  if (L > at) out.push([at, L]);
  return out;
}

/** Room a little either side of an opening: 2″ (50 mm). */
const MARGIN = 65_024;

/** Where an opening of width w goes in a wall: centred when that is free, else the middle of the widest free stretch. */
function placeIn(level: LevelView, wallId: string, w: number, units: UnitSystem, at?: { distance: number; from: 'start' | 'end' }): { offset: number; centered: boolean } | { problem: string } {
  const wall = level.walls.find((x) => x.id === wallId);
  if (wall === undefined) return { problem: 'no such wall' };
  const L = wallLength(wall);
  const spans = freeSpans(level, wallId, L);
  const fits = (o: number) => spans.some(([a, b]) => o >= a + (a === 0 ? 0 : MARGIN) && o + w <= b - (b >= L ? 0 : MARGIN));
  if (at !== undefined) {
    const o = Math.round(at.from === 'start' ? at.distance : L - at.distance - w);
    if (o < 0 || o + w > L) return { problem: `${lenText(at.distance, units)} from the ${at.from} runs off the wall` };
    if (!fits(o)) return { problem: 'it runs into an opening already there' };
    return { offset: o, centered: false };
  }
  const centred = Math.round((L - w) / 2);
  if (centred >= 0 && fits(centred)) return { offset: centred, centered: true };
  const room = spans.map(([a, b]) => [a + (a === 0 ? 0 : MARGIN), b - (b >= L ? 0 : MARGIN)] as [number, number]).filter(([a, b]) => b - a >= w).sort((x, y) => y[1] - y[0] - (x[1] - x[0]));
  const best = room[0];
  if (best === undefined) return { problem: `no free ${lenText(w, units)} between its openings` };
  return { offset: Math.round((best[0] + best[1] - w) / 2), centered: false };
}

/** The type a new door or window takes: one of that width, else the first, made that wide. */
function typeFor(model: EditorModel, kind: 'doorType' | 'windowType', width: number | undefined, height: number | undefined): { choice: TypeChoice | undefined; width: number | undefined; height: number | undefined } {
  // The types the plan uses most come first: a new door is like its doors.
  const used = new Map<string, number>();
  for (const o of Object.values((model.document.openings ?? {}) as Record<string, Json | undefined>)) {
    const fill = o?.['fill'];
    if (typeof fill === 'string') used.set(fill, (used.get(fill) ?? 0) + 1);
  }
  const choices = typeChoices(model.document, kind)
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (used.get(b.c.id) ?? 0) - (used.get(a.c.id) ?? 0) || a.i - b.i)
    .map(({ c }) => c);
  const w = (c: TypeChoice) => (typeof c.element['width'] === 'number' ? c.element['width'] : null);
  const h = (c: TypeChoice) => (typeof c.element['height'] === 'number' ? c.element['height'] : null);
  // The plan's own types first: one of that width, else its most used, made that wide. A starter
  // type is added only to a plan that has none of its own.
  const own = choices.filter((c) => !c.starter);
  const fitsAt = (c: TypeChoice, size: number | null) => size === null || w(c) === size;
  const exactIn = (pool: TypeChoice[]) => (width === undefined ? undefined : (pool.find((c) => fitsAt(c, width) && (height === undefined || h(c) === height)) ?? pool.find((c) => fitsAt(c, width))));
  // A type that declares its clear opening, or opens as a pair or slides, is made at its size: only a
  // plain hinged one is made wider or narrower by the opening's own width.
  const stretchy = (c: TypeChoice) => c.element['clearOpening'] === undefined && (c.element['operation'] === undefined || c.element['operation'] === 'swing' || c.element['operation'] === 'casement' || c.element['operation'] === 'fixed');
  const chosen = exactIn(own) ?? (width === undefined ? own[0] : own.find(stretchy)) ?? exactIn(choices) ?? choices.find(stretchy) ?? choices[0];
  return {
    choice: chosen,
    width: width !== undefined && (chosen === undefined || w(chosen) !== width) ? width : undefined,
    height: height !== undefined && (chosen === undefined || h(chosen) !== height) ? height : undefined,
  };
}

function openingIntent(ctx: PhraseContext, intent: Extract<Intent, { verb: 'addOpening' }>, picks: Picks): Outcome {
  const model = ctx.model;
  const { choice, width: ownWidth, height: ownHeight } = intent.kind === 'opening' ? { choice: undefined, width: intent.width ?? (ctx.units === 'metric' ? 1_152_000 : 1_170_432), height: intent.height } : typeFor(model, intent.kind === 'door' ? 'doorType' : 'windowType', intent.width, intent.height);
  const w = ownWidth ?? (typeof choice?.element['width'] === 'number' ? choice.element['width'] : undefined);
  if (w === undefined) return fail(`Say how wide: “add a 36-inch ${intent.kind} to …”.`);
  const noun = `${lenText(w, ctx.units)} ${intent.kind}`;
  // Where: a wall — by ID, by an Ops selector — or a room, whose walls are asked about.
  const said = fold(intent.where).replace(DETERMINERS, '');
  const ref: Ref = { said: intent.where, kinds: ['wall'], what: 'a wall or a room', key: 'wall' };
  let wallId: string | null = null;
  let selector: string | null = null;
  const idWord = said.replace(/^wall\s+/, '');
  for (const id of model.index.keys()) if (id.toLowerCase() === idWord && kindOf(model, id) === 'wall') wallId = id;
  if (wallId === null) {
    const sel = wallSelector(ctx, said, ref, picks);
    if (sel !== null) {
      wallId = sel.id;
      selector = sel.selector;
    }
  }
  if (wallId === null) {
    const room = resolveRoom(ctx, intent.where, 'room', picks);
    const level = levelOf(ctx, room);
    // Every wall of the room, by its side, as Ops' selectors name them.
    const found: { id: string; side: Dir; selector: string | null }[] = [];
    for (const side of SIDES) {
      const ids = selectWalls(model.document, `${side} wall of ${room}`);
      for (const id of ids) if (!found.some((f) => f.id === id)) found.push({ id, side, selector: ids.length === 1 ? `${side} wall of ${room}` : null });
    }
    if (found.length === 0) return fail(`${labelOf(model, room)} has no walls to put a ${intent.kind} in.`);
    const options = found.map((f): Choice => {
      const wall = level.walls.find((x) => x.id === f.id);
      const spot = placeIn(level, f.id, w, ctx.units, intent.at);
      const L = wall === undefined ? 0 : Math.round(wallLength(wall));
      return {
        value: f.id,
        label: `${f.side.charAt(0).toUpperCase()}${f.side.slice(1)} wall`,
        detail: `${f.id} · ${lenText(L, ctx.units)} long · ${'problem' in spot ? `no room for a ${noun}` : spot.centered ? 'centred' : 'beside its openings'}`,
        highlight: [f.id],
        ...('problem' in spot ? { disabled: `No room for a ${noun}` } : {}),
      };
    });
    const usable = options.filter((o) => o.disabled === undefined);
    const picked = picks['wall'];
    const pick = picked !== undefined && found.some((f) => f.id === picked) ? picked : usable.length === 1 && options.length === 1 ? usable[0]?.value : undefined;
    if (pick === undefined) {
      if (usable.length === 0) return fail(`None of ${labelOf(model, room)}’s walls has room for a ${noun}.`);
      return ask('wall', `Which wall of ${labelOf(model, room)}?`, options);
    }
    wallId = pick;
    selector = found.find((f) => f.id === pick)?.selector ?? null;
  }
  const level = levelOf(ctx, wallId);
  const spot = placeIn(level, wallId, w, ctx.units, intent.at);
  if ('problem' in spot) return fail(`A ${noun} does not fit in ${labelOf(model, wallId)}: ${spot.problem}.`);
  const wallRef = selector ?? wallId;
  const builder = addOpening(model.document, {
    wall: wallRef,
    at: spot.centered ? 'centered' : spot.offset,
    ...(choice === undefined ? {} : { fill: choice }),
    ...(ownWidth === undefined ? {} : { width: ownWidth }),
    ...(ownHeight === undefined ? {} : { height: ownHeight }),
  });
  const beside = roomsBeside(level, wallId);
  const rooms = [beside.left, beside.right].filter((r): r is string => r !== null).map((r) => labelOf(model, r));
  const where = selector !== null && /^(north|south|east|west) wall of /.test(selector) ? `the ${selector.split(' ')[0] ?? ''} wall of ${labelOf(model, selector.replace(/^\w+ wall of /, ''))} (${wallId})` : `${labelOf(model, wallId)}${rooms.length > 0 ? ` (${rooms.join(' · ')})` : ''}`;
  const summary = `Add a ${noun} to ${where}${spot.centered ? ', centred' : ''}`;
  const notes = choice === undefined ? [] : [`${choice.name}${choice.starter ? ' — added to the project’s types' : ''}`];
  return {
    status: 'ready',
    summary,
    label: `Add ${intent.kind === 'opening' ? 'an opening' : `a ${intent.kind}`}`,
    batch: builder,
    targets: [wallId],
    select: null,
    selectNew: true,
    level: level.id,
    notes,
  };
}

function placeIntent(ctx: PhraseContext, intent: Extract<Intent, { verb: 'place' }>, picks: Picks): Outcome {
  const model = ctx.model;
  const query = wordsOf(intent.what).join(' ');
  const all = entriesFor(model.document).filter((e) => e.placement !== 'opening');
  const hits = search(all, query);
  const entry = hits[0];
  if (entry === undefined) {
    if (/\b(door|window)\b/.test(query)) return fail(`Say where it goes: “add a ${query} to the pantry”.`);
    return fail(`Nothing in the library matches “${intent.what}”. Try “sofa”, “dining table”, “bed”, “receptacle”.`);
  }
  let at: Point | null = ctx.at;
  let level = model.levels.find((l) => l.id === ctx.level);
  let where = '';
  if (intent.relation === 'in' && intent.where !== undefined) {
    const room = resolveRoom(ctx, intent.where, 'room', picks);
    level = levelOf(ctx, room);
    const face = roomFace(level, room);
    if (face === undefined) return fail(`${labelOf(model, room)} has no floor to stand on.`);
    at = centroid(face.outer);
    where = ` in ${labelOf(model, room)}`;
  } else if (intent.relation === 'next' && intent.where !== undefined) {
    const id = resolveRef(ctx, { said: intent.where, kinds: ['item', 'opening', 'room'], what: 'an item', key: 'beside' }, picks);
    level = levelOf(ctx, id);
    const d = deviceOf(level, id);
    if (d === undefined) {
      if (kindOf(model, id) === 'room') return placeIntent(ctx, { ...intent, relation: 'in' }, picks);
      return fail(`Say an item to put it beside: “next to the sofa”.`);
    }
    const box = boxOf(d.element);
    const mid = middleOf(d);
    if (box === null || mid === null) return fail(`${shortName(model, id)} has no footprint to stand beside.`);
    const f = frameVectors(d);
    const half = (box.max[1] - box.min[1]) / 2 + (entry.box.max[1] - entry.box.min[1]) / 2 + MARGIN;
    // To its left, as it faces.
    at = [mid[0] + f.v[0] * half, mid[1] + f.v[1] * half];
    where = ` next to ${shortName(model, id)}`;
  } else if (intent.relation === 'against' && intent.where !== undefined) {
    const id = resolveRef(ctx, { said: intent.where, kinds: ['wall'], what: 'a wall', key: 'against' }, picks);
    level = levelOf(ctx, id);
    const wall = level.walls.find((x) => x.id === id);
    if (wall === undefined) return fail('Say a wall: “against the north wall of the den”.');
    at = [(wall.a[0] + wall.b[0]) / 2, (wall.a[1] + wall.b[1]) / 2];
    where = ` against ${labelOf(model, id)}`;
  }
  if (level === undefined || at === null) return fail('Point at where it goes, or say a room: “… in the den”.');
  const ghost = ghostOf(level, entry, at, {
    tol: 150 * 1_280,
    grid: gridStep(ctx.units),
    rotation: 0,
    turned: false,
    roomName: (id) => labelOf(model, id),
    wallName: (id) => labelOf(model, id),
  });
  if (ghost === null || ghost.host === null) return fail(`${entry.name} cannot go there.`);
  if (ghost.problem !== undefined) return fail(`${entry.name}: ${ghost.problem}`);
  const summary = `Place ${entry.name}${where}`;
  const room = ghost.host.mode === 'surface' ? ghost.host.room : null;
  return { status: 'ready', summary, label: summary, place: { entry, ghost }, targets: room === null ? [] : [room], select: null, level: level.id, notes: ghost.label === '' ? [] : [ghost.label] };
}

function renameIntent(ctx: PhraseContext, intent: Extract<Intent, { verb: 'rename' }>, picks: Picks): Outcome {
  const model = ctx.model;
  const said = fold(intent.ref).replace(DETERMINERS, '');
  // A level by its name or ID first: "rename level 1 to Ground floor".
  const levels = describeLevels(model).filter((l) => l.name === said || l.id.toLowerCase() === said.replace(/^level\s+/, '') || l.name === said.replace(/^level\s+/, ''));
  const id = levels.length === 1 ? (levels[0] as Described).id : resolveRef(ctx, { said: intent.ref, kinds: ['room', 'item', 'wall', 'opening', 'separator', 'level'], what: 'a room, an item, a wall or an opening', key: 'target' }, picks);
  const was = shortName(model, id);
  if (labelOf(model, id) === intent.name) return fail(`${was} is already called “${intent.name}”.`);
  const summary = `Rename ${was} to “${intent.name}”`;
  const level = model.levels.find((l) => l.id === id) ?? levelOf(ctx, id);
  return { status: 'ready', summary, label: summary, batch: setProperty(id, '/name', intent.name), targets: [id], select: kindOf(model, id) === 'level' ? null : id, level: level.id, notes: [] };
}

/** The project's materials a phrase names: by ID, by name, by every word; paint first when painting. */
function findMaterials(model: EditorModel, said: string, paint: boolean): { id: string; name: string }[] {
  const all = Object.entries((model.document.materials ?? {}) as Record<string, Json | undefined>).filter((e): e is [string, Json] => isObject(e[1])).map(([id, m]) => ({ id, name: typeof m['name'] === 'string' ? m['name'] : id }));
  const n = fold(said);
  const exact = all.filter((m) => m.id.toLowerCase() === n || fold(m.name) === n);
  if (exact.length > 0) return exact;
  const words = wordsOf(said);
  if (words.length === 0) return [];
  let hits = all.filter((m) => {
    const bag = new Set([...wordsOf(m.name), ...wordsOf(m.id.replace(/-/g, ' '))]);
    return words.every((w) => bag.has(w));
  });
  if (paint && hits.length > 1) {
    const painted = hits.filter((m) => m.id.startsWith('paint') || /^paint\b/i.test(m.name));
    if (painted.length > 0) hits = painted;
  }
  return hits.sort((a, b) => byId(a.id, b.id));
}

function finishIntent(ctx: PhraseContext, intent: Extract<Intent, { verb: 'finish' }>, picks: Picks): Outcome {
  const model = ctx.model;
  let missing: string | null = null;
  for (const split of intent.splits) {
    if (findRooms(ctx, split.room).length === 0) continue;
    const mats = findMaterials(model, split.material, intent.paint);
    if (mats.length === 0) {
      missing ??= split.material;
      continue;
    }
    const room = resolveRoom(ctx, split.room, 'room', picks);
    let material = mats[0]?.id as string;
    if (mats.length > 1) {
      const picked = picks['material'];
      if (picked !== undefined && mats.some((m) => m.id === picked)) material = picked;
      else return ask('material', `Which “${split.material}”?`, mats.map((m) => ({ value: m.id, label: m.name, detail: m.id, highlight: [room] })));
    }
    const level = levelOf(ctx, room);
    const surface = intent.surface;
    const summary = `Set ${labelOf(model, room)}’s ${surface === 'wall' ? 'walls' : surface} to ${labelOf(model, material)}`;
    const op = { op: 'setRoomFinish', room, surface, material } as Operation;
    return { status: 'ready', summary, label: summary, batch: [op], targets: [room], select: room, level: level.id, notes: [] };
  }
  if (missing !== null) return fail(`There is no material called “${missing}” in this project. Add it from the materials library (Materials in the top bar), then say it again.`);
  return fail(`I can’t find the room in “${intent.splits[0]?.room ?? ''}”.`);
}

/**
 * The outcome of a phrase against the model: ready (a batch, or a placement, with what it says), a
 * question (which element), or why not. `picks` are the answers to earlier questions, by key.
 */
export function interpret(text: string, ctx: PhraseContext, picks: Picks = {}): Outcome {
  if (ctx.level === null) return { status: 'fail', message: 'Open a level first.' };
  const parsed = parsePhrase(text, ctx.units);
  if (!parsed.ok) return { status: 'fail', message: parsed.reason };
  return outcomeOf(parsed.intent, ctx, picks);
}

export function outcomeOf(intent: Intent, ctx: PhraseContext, picks: Picks = {}): Outcome {
  return withRiders(ctx.model, outcomeFor(intent, ctx, picks));
}

/** What rides on what the batch moves goes with it (FLR-T-18.18, carry.ts): said on the card. */
function withRiders(model: EditorModel, o: Outcome): Outcome {
  if (o.status !== 'ready' || o.batch === undefined || typeof o.batch === 'function') return o;
  const moved = new Set(o.batch.map((op) => (op as unknown as Json)['element']).filter((x): x is string => typeof x === 'string'));
  const carried = carryRiders(model, o.batch)
    .map((op) => (op as unknown as Json)['op'] === 'moveElement' ? (op as unknown as Json)['element'] : undefined)
    .filter((x): x is string => typeof x === 'string' && !moved.has(x));
  const riders = [...new Set(carried)].filter((id) => labelOf(model, id) !== id);
  if (riders.length === 0) return o;
  const names = [...new Set(riders.map((id) => shortName(model, id)))];
  return { ...o, targets: [...o.targets, ...riders], notes: [...o.notes, `${names.join(', ')} ${riders.length === 1 ? 'moves' : 'move'} with it`] };
}

function outcomeFor(intent: Intent, ctx: PhraseContext, picks: Picks): Outcome {
  try {
    switch (intent.verb) {
      case 'move':
        return moveIntent(ctx, intent, picks);
      case 'resize':
        return resizeIntent(ctx, intent, picks);
      case 'addOpening':
        return openingIntent(ctx, intent, picks);
      case 'place':
        return placeIntent(ctx, intent, picks);
      case 'rename':
        return renameIntent(ctx, intent, picks);
      case 'finish':
        return finishIntent(ctx, intent, picks);
    }
  } catch (e) {
    if (e instanceof Ask) return e.outcome;
    throw e;
  }
}

export { CAN_DO };
