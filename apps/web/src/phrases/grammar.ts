import { parseLength } from '@floorspec/ops';
import { parseLen, type UnitSystem } from '../editor/units';

/**
 * Say it on the plan (FLR-T-18.15): the phrase grammar. A plain sentence — "push the island 6 inches
 * north", "add a 36-inch door to the pantry" — read by rules, offline, the same way every time, into
 * an intent: what to do, to what (still in words: the resolver finds the element), by how much. No
 * model is read here and no LLM is asked; a phrase outside the grammar gets "I can do: …" and the
 * examples, never a guess.
 *
 * Lengths are the Ops reference grammar's (Ops 3.1, `parseLength`), reached from how people write
 * them: `6 inches`, `36-inch`, `3'6"`, `3 feet 6 inches`, `10 ft`, `1 1/2"`, `half an inch`, `a foot`,
 * `900 mm`, `90 cm`, `2.4 m`, and ′ ″ for ' ". A bare number where a length is wanted is read in the
 * project's working unit — inches in feet and inches, millimetres in metric — as a typed length is.
 *
 * Directions are compass words in the project's frame: north is project north, +y, up on the plan —
 * the frame Ops' own vectors and selectors use (Ops 3.2, 3.3: "2' east", "north wall of Kitchen"),
 * so "6 inches north" and "the north wall of the Pantry" agree. Up, down, left and right are the
 * plan as drawn: up is north. A site's true north (Core 1.8) is not used: it turns the sun and the
 * north arrow of a drawing, not the words. The decision is FLR-ADR-049.
 */

export type Dir = 'north' | 'south' | 'east' | 'west';
export type Axis = 'length' | 'width' | 'depth' | 'height';
export type Surface = 'floor' | 'wall' | 'ceiling';
export type OpeningKind = 'door' | 'window' | 'opening';

/** Where a move takes something other than "by a distance". */
export type MoveTo =
  | { kind: 'wall'; side: Dir }
  | { kind: 'centre' }
  | { kind: 'point'; point: [number, number] };

export type Intent =
  /** Move or push something: by a distance in a direction, or to a wall, the room's middle, a point. */
  | { verb: 'move'; ref: string; by?: { distance: number | null; dir: Dir }; to?: MoveTo; nudge: boolean }
  /**
   * Resize: each change is an axis set `to` a length or changed `by` one (signed). `side`, for a room,
   * is the side that moves.
   */
  | { verb: 'resize'; ref: string; changes: { axis: Axis; mode: 'to' | 'by'; value: number }[]; side?: Dir }
  /** Add a door, window or plain opening to a wall or a room's walls, centred unless `at` says where. */
  | { verb: 'addOpening'; kind: OpeningKind; width?: number; height?: number; where: string; at?: { distance: number; from: 'start' | 'end' } }
  /** Place an item from the library: in a room, next to an item, against a wall, or where the bar is. */
  | { verb: 'place'; what: string; relation: 'in' | 'next' | 'against' | 'here'; where?: string }
  | { verb: 'rename'; ref: string; name: string }
  /** A room's finish; `splits` are the ways the words read as room and material, tried in order. */
  | { verb: 'finish'; surface: Surface; splits: { room: string; material: string }[]; paint: boolean };

export type Parsed = { ok: true; intent: Intent } | { ok: false; reason: string };

/** What the bar offers when a phrase is not one it reads. */
export const EXAMPLES: readonly string[] = [
  'push the island 6 inches north',
  'move the sofa to the north wall',
  'make the island 10 feet long',
  'widen the door to 36 inches',
  'add a 36-inch door to the pantry',
  'add a window to the north wall of the den',
  'place a sofa in the great room',
  'rename room 1 to Living',
  'make the kitchen floor oak',
  'paint the bedroom walls sage',
];

export const CAN_DO = 'I can do: move, resize, add a door or window, place an item, rename, set a finish.';

// ─── Lengths ─────────────────────────────────────────────────────────────────────────────────

const WORD_NUMBERS: Readonly<Record<string, string>> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', fifteen: '15', eighteen: '18', twenty: '20', thirty: '30', a: '1', an: '1',
};
const HALF = '(?:an?\\s+half|half\\s+an?|half)';
const NUM = `(?:\\d+(?:\\s+|-)\\d+\\/\\d+|\\d+\\/\\d+|\\d+(?:\\.\\d+)?|\\.\\d+|${HALF}|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|eighteen|twenty|thirty|an?)`;
const FT = `(?:'|ft\\b\\.?|feet\\b|foot\\b)`;
/** `in` is inches only when it is not the preposition: "6 in north", never "a sofa in the den". */
const IN = `(?:"|''|in\\b\\.?(?!\\s+(?:the|a|an|my|this|that|it|front|there|here|room|kitchen)\\b)|inch(?:es)?\\b)`;
const METRIC = `(?:mm\\b|millimet(?:er|re)s?\\b|cm\\b|centimet(?:er|re)s?\\b|met(?:er|re)s?\\b|m\\b)`;
/** A length with its units: feet and inches (and feet then a bare number of inches), inches, metric. */
const LENGTH_RE = new RegExp(
  `(?<![\\w.\\/])(?:${NUM}\\s*-?\\s*${FT}(?:\\s*(?:and\\s+|-\\s*)?${NUM}\\s*-?\\s*${IN}|\\s*-?\\s*\\d+(?:\\s+\\d+\\/\\d+)?(?![\\w\\/'"]))?|${NUM}\\s*-?\\s*${IN}|${NUM}\\s*-?\\s*${METRIC})`,
  'gi',
);

/** One length as written, in the Ops grammar's spelling, or null. */
function grammarOf(written: string): string | null {
  let s = written.toLowerCase().replace(/[\u2032\u2019]/g, "'").replace(/[\u2033\u201D]/g, '"');
  s = s.replace(new RegExp(`\\b${HALF}\\b`, 'g'), '1/2');
  s = s.replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|eighteen|twenty|thirty|an?)\b/g, (w) => WORD_NUMBERS[w] ?? w);
  s = s.replace(/''/g, 'in').replace(/"/g, 'in').replace(/'/g, 'ft');
  s = s.replace(/\b(feet|foot|ft\.?)/g, 'ft').replace(/\b(inches|inch|in\.)/g, 'in');
  s = s.replace(/\bmillimet(?:er|re)s?\b/g, 'mm').replace(/\bcentimet(?:er|re)s?\b/g, 'cm').replace(/\bmet(?:er|re)s?\b/g, 'm');
  s = s.replace(/\band\b/g, ' ');
  // "36-inch", "6-foot": the hyphen of an adjective, not the grammar's.
  s = s.replace(/(\d)\s*-\s*(ft|in|mm|cm|m)\b/g, '$1 $2');
  // "3ft 6": the inches' unit understood.
  s = s.replace(/ft\s*-?\s*(\d+(?:\s+\d+\/\d+)?)\s*$/, 'ft $1in');
  s = s.replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
}

/** A length as written, in base units; null when it is not one. */
export function lengthOf(written: string): number | null {
  const g = grammarOf(written);
  if (g === null) return null;
  const p = parseLength(g);
  if (!p.ok || p.value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(p.value);
}

/** The phrase with each written length replaced by ⟦i⟧, and the lengths. */
export function extractLengths(text: string): { text: string; lengths: number[] } {
  const lengths: number[] = [];
  const out = text.replace(LENGTH_RE, (m) => {
    const v = lengthOf(m);
    if (v === null) return m;
    lengths.push(v);
    return ` ⟦${String(lengths.length - 1)}⟧ `;
  });
  return { text: out.replace(/\s+/g, ' ').trim(), lengths };
}

// ─── Words ───────────────────────────────────────────────────────────────────────────────────

/** Tidy what was typed: curly quotes, primes, spaces, a trailing full stop, "please" and "can you". */
export function normalize(raw: string): string {
  let s = raw
    .replace(/[‘’′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/×/g, ' x ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?]+$/, '')
    .replace(/,?\s*please$/i, '')
    .trim();
  for (;;) {
    const next = s.replace(/^(?:please|pls|kindly|ok|okay|now|then|and|can you|could you|would you|will you|i want to|i'd like to|i would like to|let's|lets|go ahead and)\s+/i, '');
    if (next === s) break;
    s = next;
  }
  return s;
}

const DIR_WORDS: Readonly<Record<string, Dir>> = {
  north: 'north', south: 'south', east: 'east', west: 'west',
  up: 'north', down: 'south', right: 'east', left: 'west',
  upward: 'north', downward: 'south', northward: 'north', southward: 'south', eastward: 'east', westward: 'west',
};
const DIR = '(north|south|east|west|up|down|left|right|upward|downward|northward|southward|eastward|westward)s?';
/** "north", "to the north", "towards the north", "northwards", "up". */
const DIR_PHRASE = `(?:(?:to|towards?)\\s+the\\s+)?${DIR}`;
const dirOf = (w: string | undefined): Dir | undefined => (w === undefined ? undefined : DIR_WORDS[w.toLowerCase().replace(/s$/, '')]);

/** A length token in a pattern: a written length (⟦i⟧) or a bare number. */
const L = '(⟦\\d+⟧|\\d+(?:\\.\\d+)?)';

const AXIS_WORDS: Readonly<Record<string, Axis>> = {
  long: 'length', length: 'length', wide: 'width', width: 'width', deep: 'depth', depth: 'depth', tall: 'height', high: 'height', height: 'height',
};
const COMPARATIVES: Readonly<Record<string, [Axis, 1 | -1]>> = {
  longer: ['length', 1], shorter: ['length', -1], wider: ['width', 1], narrower: ['width', -1], deeper: ['depth', 1],
  shallower: ['depth', -1], taller: ['height', 1], higher: ['height', 1], lower: ['height', -1], bigger: ['length', 1], smaller: ['length', -1],
};

// ─── The grammar ─────────────────────────────────────────────────────────────────────────────

/**
 * Read a phrase. `units` is the project's display system, for bare numbers. A phrase that is not
 * in the grammar answers why, in words a person can act on.
 */
export function parsePhrase(raw: string, units: UnitSystem): Parsed {
  const said = normalize(raw);
  if (said === '') return { ok: false, reason: CAN_DO };
  // Names are taken as written, before any length is read out of them: "rename room 1 to Bedroom 2".
  const renamed = rename(said);
  if (renamed !== null) return renamed;
  const { text, lengths } = extractLengths(said);
  const len = (token: string | undefined): number | null => {
    if (token === undefined) return null;
    const m = /^⟦(\d+)⟧$/.exec(token);
    if (m !== null) return lengths[Number(m[1])] ?? null;
    const p = parseLen(token, units);
    return p.ok ? p.value : null;
  };
  return move(text, len) ?? resize(text, len) ?? opening(text, len) ?? finish(said) ?? place(text) ?? explain(said);
}

type Len = (token: string | undefined) => number | null;
const re = (source: string) => new RegExp(`^${source}$`, 'i');
const strip = (s: string) => s.trim().replace(/\s+/g, ' ');

// Move ──────────────────────────────────────────────────────────────────────────────────────────

const MOVE_VERB = '(?:move|push|nudge|shift|slide|pull|bump|scoot|drag)';

function move(text: string, len: Len): Parsed | null {
  const verb = new RegExp(`^(${MOVE_VERB})\\s+`, 'i').exec(text);
  if (verb === null) return null;
  const nudge = verb[1]?.toLowerCase() === 'nudge';
  let m = re(`${MOVE_VERB}\\s+(.+?)\\s+(?:by\\s+)?${L}\\s+${DIR_PHRASE}`).exec(text) ?? null;
  if (m !== null) return moveBy(m[1], len(m[2]), dirOf(m[3]), nudge);
  m = re(`${MOVE_VERB}\\s+(.+?)\\s+${DIR_PHRASE}\\s+(?:by\\s+)?${L}`).exec(text);
  if (m !== null) return moveBy(m[1], len(m[3]), dirOf(m[2]), nudge);
  // Against a wall of its room: "move the sofa to the north wall", "push the bed against the east wall".
  m = re(`${MOVE_VERB}\\s+(.+?)\\s+(?:(?:up\\s+)?to|against|flush\\s+(?:with|to|against))\\s+(?:the\\s+)?${DIR}\\s+wall`).exec(text);
  if (m !== null) {
    const side = dirOf(m[2]);
    if (side === undefined) return null;
    return { ok: true, intent: { verb: 'move', ref: strip(m[1] ?? ''), to: { kind: 'wall', side }, nudge } };
  }
  m = re(`${MOVE_VERB}\\s+(.+?)\\s+(?:in)?to\\s+the\\s+(?:middle|centre|center)(?:\\s+of\\s+(?:the|its)\\s+room)?`).exec(text);
  if (m !== null) return { ok: true, intent: { verb: 'move', ref: strip(m[1] ?? ''), to: { kind: 'centre' }, nudge } };
  m = re(`${MOVE_VERB}\\s+(.+?)\\s+to\\s+${L}\\s*,\\s*${L}`).exec(text);
  if (m !== null) {
    const x = len(m[2]);
    const y = len(m[3]);
    if (x === null || y === null) return { ok: false, reason: 'Say the point as two lengths: x, y — such as 12\', 8\'6"' };
    return { ok: true, intent: { verb: 'move', ref: strip(m[1] ?? ''), to: { kind: 'point', point: [x, y] }, nudge } };
  }
  // A direction and no distance: a nudge is one nudge step; anything else asks how far.
  m = re(`${MOVE_VERB}\\s+(.+?)\\s+${DIR_PHRASE}`).exec(text);
  if (m !== null) {
    if (nudge) return moveBy(m[1], null, dirOf(m[2]), true);
    return { ok: false, reason: `How far? Say a distance: “${verb[1]?.toLowerCase() ?? 'move'} ${strip(m[1] ?? 'it')} 6 inches ${dirOf(m[2]) ?? 'north'}”.` };
  }
  return { ok: false, reason: `Which way, and how far? Say a distance and a direction — “${verb[1]?.toLowerCase() ?? 'move'} the island 6 inches north” — or a wall: “move the sofa to the north wall”.` };
}

function moveBy(ref: string | undefined, distance: number | null, dir: Dir | undefined, nudge: boolean): Parsed {
  if (dir === undefined) return { ok: false, reason: 'Which way? north, south, east or west (or up, down, left, right on the plan).' };
  if (distance !== null && distance <= 0) return { ok: false, reason: 'Say a distance longer than zero.' };
  return { ok: true, intent: { verb: 'move', ref: strip(ref ?? ''), by: { distance, dir }, nudge } };
}

// Resize ────────────────────────────────────────────────────────────────────────────────────────

function resize(text: string, len: Len): Parsed | null {
  let m = re(`(?:make|set|resize|size|change)\\s+(.+?)\\s+(?:to\\s+|be\\s+|into\\s+)?${L}\\s+(long|wide|deep|tall|high)`).exec(text);
  if (m !== null) return change(m[1], AXIS_WORDS[m[3]?.toLowerCase() ?? ''], 'to', len(m[2]));
  // "make the sofa 84 by 36": width × depth, as a card reads.
  m = re(`(?:make|set|resize|size|change)\\s+(.+?)\\s+(?:to\\s+|be\\s+)?${L}\\s*(?:x|by)\\s*${L}`).exec(text);
  if (m !== null) {
    const w = len(m[2]);
    const d = len(m[3]);
    if (w === null || d === null || w <= 0 || d <= 0) return { ok: false, reason: 'Say both sizes as lengths: 84" by 36".' };
    return { ok: true, intent: { verb: 'resize', ref: strip(m[1] ?? ''), changes: [{ axis: 'width', mode: 'to', value: w }, { axis: 'depth', mode: 'to', value: d }] } };
  }
  m = re(`(?:make|set|change)\\s+(.+?)'?s?\\s+(length|width|depth|height)\\s+(?:to\\s+|be\\s+)?${L}`).exec(text);
  if (m !== null) return change(m[1], AXIS_WORDS[m[2]?.toLowerCase() ?? ''], 'to', len(m[3]));
  m = re(`(?:make|set|change)\\s+the\\s+(length|width|depth|height)\\s+of\\s+(.+?)\\s+(?:to\\s+)?${L}`).exec(text);
  if (m !== null) return change(m[2], AXIS_WORDS[m[1]?.toLowerCase() ?? ''], 'to', len(m[3]));
  // "make the island 6 inches longer", "make the pantry a foot wider to the east".
  m = re(`(?:make)\\s+(.+?)\\s+${L}\\s+(longer|shorter|wider|narrower|deeper|shallower|taller|higher|lower|bigger|smaller)(?:\\s+(?:on\\s+the\\s+|to\\s+the\\s+|towards?\\s+the\\s+)?${DIR}(?:\\s+side)?)?`).exec(text);
  if (m !== null) {
    const c = COMPARATIVES[m[3]?.toLowerCase() ?? ''];
    const v = len(m[2]);
    if (c === undefined || v === null || v <= 0) return { ok: false, reason: 'Say how much: “make the island 6 inches longer”.' };
    return { ok: true, intent: { verb: 'resize', ref: strip(m[1] ?? ''), changes: [{ axis: c[0], mode: 'by', value: c[1] * v }], ...(dirOf(m[4]) === undefined ? {} : { side: dirOf(m[4]) as Dir }) } };
  }
  // "widen the door to 36 inches", "lengthen the island by 1 foot", "shorten the sofa to 72".
  m = re(`(widen|narrow|lengthen|shorten|deepen|heighten|stretch)\\s+(.+?)\\s+(to|by)\\s+${L}`).exec(text);
  if (m !== null) {
    const w = m[1]?.toLowerCase() ?? '';
    const axis: Axis = w === 'widen' || w === 'narrow' ? 'width' : w === 'deepen' ? 'depth' : w === 'heighten' ? 'height' : 'length';
    const sign = w === 'narrow' || w === 'shorten' ? -1 : 1;
    const v = len(m[4]);
    if (v === null || v <= 0) return { ok: false, reason: 'Say a length longer than zero.' };
    return { ok: true, intent: { verb: 'resize', ref: strip(m[2] ?? ''), changes: [{ axis, mode: m[3]?.toLowerCase() === 'to' ? 'to' : 'by', value: m[3]?.toLowerCase() === 'to' ? v : sign * v }] } };
  }
  // A room grown or shrunk on one side: "extend the pantry 2 feet east", "shrink the den 1 foot on the west".
  m = re(`(extend|grow|enlarge|expand|stretch|shrink|reduce|trim|shorten)\\s+(.+?)\\s+(?:by\\s+)?${L}\\s+(?:on\\s+the\\s+|from\\s+the\\s+|to\\s+the\\s+|towards?\\s+the\\s+)?${DIR}(?:\\s+side)?`).exec(text);
  if (m !== null) {
    const v = len(m[3]);
    const side = dirOf(m[4]);
    if (v === null || v <= 0 || side === undefined) return { ok: false, reason: 'Say how much and which side: “extend the pantry 2 feet east”.' };
    const out = ['shrink', 'reduce', 'trim', 'shorten'].includes(m[1]?.toLowerCase() ?? '') ? -v : v;
    return { ok: true, intent: { verb: 'resize', ref: strip(m[2] ?? ''), changes: [{ axis: 'length', mode: 'by', value: out }], side } };
  }
  return null;
}

function change(ref: string | undefined, axis: Axis | undefined, mode: 'to' | 'by', value: number | null): Parsed {
  if (axis === undefined) return { ok: false, reason: 'Say long, wide, deep or tall.' };
  if (value === null || value <= 0) return { ok: false, reason: 'Say a length longer than zero.' };
  return { ok: true, intent: { verb: 'resize', ref: strip(ref ?? ''), changes: [{ axis, mode, value }] } };
}

// Add an opening ────────────────────────────────────────────────────────────────────────────────

const OPENING_NOUN = '(door(?:way)?|window|cased\\s+opening|opening|pass-?through)';

function opening(text: string, len: Len): Parsed | null {
  const m = re(`(?:add|put|insert|cut|make|place|create|install)\\s+(?:in\\s+)?(?:a|an|one|another|new)?\\s*(?:new\\s+)?(.*?)\\s*${OPENING_NOUN}(?:\\s+(.*?))?`).exec(text);
  if (m === null) return null;
  const noun = (m[2] ?? '').toLowerCase();
  const kind: OpeningKind = noun === 'door' ? 'door' : noun === 'window' ? 'window' : 'opening';
  let width: number | undefined;
  let height: number | undefined;
  // Before the noun: "36-inch", "36 x 80", "3' wide".
  const before = strip(m[1] ?? '');
  if (before !== '') {
    const sized = re(`${L}(?:\\s*(?:x|by)\\s*${L})?(?:\\s+wide)?`).exec(before);
    // Not a size: "a chair by the window" is a placement, not an opening.
    if (sized === null) return null;
    width = len(sized[1]) ?? undefined;
    height = len(sized[2]) ?? undefined;
    if (width === undefined) return { ok: false, reason: 'Say the width as a length: 36", 3\', 900 mm.' };
  }
  let rest = strip(m[3] ?? '');
  // After the noun: "36 inches wide", then where, then where along the wall.
  const wide = re(`${L}\\s+wide(?:\\s+(.*))?`).exec(rest);
  if (wide !== null) {
    width = len(wide[1]) ?? width;
    rest = strip(wide[2] ?? '');
  }
  const where = re(`(?:(?:to|in|on|into|onto|for|at|through)\\s+(.+)|(between\\s+.+))`).exec(rest);
  if (where === null) return { ok: false, reason: `Where? Name a room or a wall: “add a ${kind} to the pantry”, “… to the north wall of the den”.` };
  let place = strip(where[1] ?? where[2] ?? '');
  let at: { distance: number; from: 'start' | 'end' } | undefined;
  const along = re(`(.+?),?\\s+${L}\\s+from\\s+(?:the|its)?\\s*(start|end)`).exec(place);
  if (along !== null) {
    const d = len(along[2]);
    if (d === null) return { ok: false, reason: 'Say how far from the start or end as a length.' };
    at = { distance: d, from: along[3]?.toLowerCase() === 'end' ? 'end' : 'start' };
    place = strip(along[1] ?? '');
  } else {
    place = place.replace(/,?\s+(?:centered|centred|in\s+the\s+(?:middle|centre|center))$/i, '');
  }
  if (width !== undefined && width <= 0) return { ok: false, reason: 'Say a width longer than zero.' };
  return { ok: true, intent: { verb: 'addOpening', kind, ...(width === undefined ? {} : { width }), ...(height === undefined ? {} : { height }), where: place, ...(at === undefined ? {} : { at }) } };
}

// Place an item ─────────────────────────────────────────────────────────────────────────────────

function place(text: string): Parsed | null {
  const verb = /^(?:place|put|add|insert|drop|bring|install)\s+(?:in\s+)?(?:a|an|one|another|some|the|new)?\s*(.+)$/i.exec(text);
  if (verb === null) return null;
  const rest = strip(verb[1] ?? '');
  const rel = /^(.+?)\s+(next\s+to|beside|alongside|by|near|against|in|inside|into|on)\s+(?:the\s+)?(.+)$/i.exec(rest);
  if (rel === null) return { ok: true, intent: { verb: 'place', what: rest, relation: 'here' } };
  const word = (rel[2] ?? '').toLowerCase().replace(/\s+/g, ' ');
  const relation = word === 'against' ? 'against' : ['next to', 'beside', 'alongside', 'by', 'near'].includes(word) ? 'next' : 'in';
  return { ok: true, intent: { verb: 'place', what: strip(rel[1] ?? ''), relation, where: strip(rel[3] ?? '') } };
}

// Rename ────────────────────────────────────────────────────────────────────────────────────────

const unquote = (s: string) => strip(s).replace(/^["']+|["']+$/g, '').trim();

function rename(said: string): Parsed | null {
  const m =
    re(`(?:rename|re-name|retitle|relabel)\\s+(.+?)\\s+(?:to|as)\\s+(.+)`).exec(said) ??
    re(`(?:change|set)\\s+the\\s+name\\s+of\\s+(.+?)\\s+to\\s+(.+)`).exec(said) ??
    re(`(?:call|name)\\s+(.+?)\\s+(?:as\\s+)?(".+")`).exec(said);
  if (m === null) {
    if (/^(?:rename|re-name)\b/i.test(said)) return { ok: false, reason: 'Say what to call it: “rename room 1 to Living”.' };
    return null;
  }
  const name = unquote(m[2] ?? '');
  if (name === '') return { ok: false, reason: 'Say the new name.' };
  if (name.length > 200) return { ok: false, reason: 'A name is at most 200 characters.' };
  return { ok: true, intent: { verb: 'rename', ref: strip(m[1] ?? ''), name } };
}

// Set a finish ──────────────────────────────────────────────────────────────────────────────────

const SURFACE = '(floor|floors|flooring|walls?|ceilings?)';
const surfaceOf = (w: string | undefined): Surface => (w === undefined ? 'wall' : /^floor/i.test(w) ? 'floor' : /^ceiling/i.test(w) ? 'ceiling' : 'wall');

function finish(said: string): Parsed | null {
  const text = said.replace(/\s+/g, ' ');
  // "set the floor of the kitchen to oak".
  let m = re(`(?:make|set|change|turn|finish|do|switch)\\s+the\\s+${SURFACE}\\s+(?:of|in)\\s+(?:the\\s+)?(.+?)\\s+(?:to|in|as|with|into)\\s+(.+)`).exec(text);
  if (m !== null) return finishOf(surfaceOf(m[1]), [{ room: m[2] ?? '', material: m[3] ?? '' }], false);
  // "make the kitchen floor oak", "set the den's walls to navy", "change the bath floor to porcelain tile".
  m = re(`(?:make|set|change|turn|finish|do|switch)\\s+(?:the\\s+)?(.+?)(?:'s)?\\s+${SURFACE}\\s+(?:to\\s+|in\\s+|as\\s+|with\\s+|into\\s+)?(?:be\\s+)?(.+)`).exec(text);
  if (m !== null) return finishOf(surfaceOf(m[2]), [{ room: m[1] ?? '', material: m[3] ?? '' }], false);
  // "use oak for the kitchen floor", "use sage on the den walls".
  m = re(`use\\s+(.+?)\\s+(?:for|on|in)\\s+(?:the\\s+)?(.+?)(?:'s)?\\s+${SURFACE}`).exec(text);
  if (m !== null) return finishOf(surfaceOf(m[3]), [{ room: m[2] ?? '', material: m[1] ?? '' }], false);
  // "paint the bedroom walls sage", "paint the den navy", "paint the kitchen ceiling white".
  m = re(`paint\\s+(?:the\\s+)?(.+)`).exec(text);
  if (m !== null) {
    const rest = strip(m[1] ?? '');
    const surf = re(`(.+?)(?:'s)?\\s+${SURFACE}\\s+(?:in\\s+|to\\s+)?(.+)`).exec(rest);
    if (surf !== null) return finishOf(surfaceOf(surf[2]), [{ room: surf[1] ?? '', material: surf[3] ?? '' }], true);
    const of = re(`(?:the\\s+)?${SURFACE}\\s+(?:of|in)\\s+(?:the\\s+)?(.+?)\\s+(.+)`).exec(rest);
    const words = rest.split(' ');
    // "paint the guest bedroom sage": every split of the words into a room and a material, longest room first.
    const splits = [];
    for (let i = words.length - 1; i >= 1; i--) splits.push({ room: words.slice(0, i).join(' '), material: words.slice(i).join(' ') });
    if (of !== null) return finishOf(surfaceOf(of[1]), [{ room: of[2] ?? '', material: of[3] ?? '' }], true);
    if (splits.length === 0) return { ok: false, reason: 'Say the room and the colour: “paint the den sage”.' };
    return finishOf('wall', splits, true);
  }
  return null;
}

function finishOf(surface: Surface, splits: { room: string; material: string }[], paint: boolean): Parsed {
  const clean = splits.map((s) => ({ room: strip(s.room).replace(/^the\s+/i, ''), material: strip(s.material).replace(/^(?:the|a|an|some)\s+/i, '').replace(/\s+(?:paint|colou?r)$/i, '') })).filter((s) => s.room !== '' && s.material !== '');
  if (clean.length === 0) return { ok: false, reason: 'Say the room and the material: “make the kitchen floor oak”.' };
  return { ok: true, intent: { verb: 'finish', surface, splits: clean, paint } };
}

// Not understood ────────────────────────────────────────────────────────────────────────────────

function explain(said: string): Parsed {
  const first = said.split(' ')[0]?.toLowerCase() ?? '';
  if (['delete', 'remove', 'erase'].includes(first)) return { ok: false, reason: `Removing is not something I do from a phrase — select it and press Delete. ${CAN_DO}` };
  if (['undo', 'redo'].includes(first)) return { ok: false, reason: `Undo is ⌘Z. ${CAN_DO}` };
  if (['rotate', 'turn', 'spin'].includes(first)) return { ok: false, reason: `Turning is [ and ] on the selection. ${CAN_DO}` };
  return { ok: false, reason: CAN_DO };
}

/** The intent in a line, for the palette's item: "move · the island · 6″ north". */
export function verbOf(intent: Intent): string {
  switch (intent.verb) {
    case 'move':
      return 'Move';
    case 'resize':
      return 'Resize';
    case 'addOpening':
      return `Add a ${intent.kind}`;
    case 'place':
      return 'Place';
    case 'rename':
      return 'Rename';
    case 'finish':
      return intent.paint ? 'Paint' : 'Set a finish';
  }
}
