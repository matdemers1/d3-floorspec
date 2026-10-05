/**
 * The DSL's syntax: one statement per line, `#` starts a comment. A line is read with a cursor that
 * knows the DSL's tokens — words, quoted names, lengths in the Ops reference grammar (3.1) plus bare
 * numbers in the plan's unit, sizes (`14x12`), points (`10', 4'`) and areas (3.6) — and every error
 * says where it is, by line and column.
 *
 * Lengths are parsed by `@floorspec/ops`' own `parseLength` and `parseArea`, so the DSL means
 * exactly what an operation's length string means: an exact rational, rounded once, ties to even.
 */
import { parseArea, parseLength } from '@floorspec/ops';
import { DslError, type Pos } from './diagnostics.js';

export type Side = 'north' | 'south' | 'east' | 'west';
export type Direction = 'east-of' | 'west-of' | 'north-of' | 'south-of';
export type Edge = Side | 'center';
export type UnitSystem = 'imperial' | 'metric';
export type Justification = 'center' | 'exteriorFace' | 'interiorFace' | 'coreFace';
export type AdjacencyKind = 'required' | 'preferred' | 'forbidden';

export interface Ref {
  readonly name: string;
  readonly pos: Pos;
}

export type Placement =
  | { readonly kind: 'at'; readonly x: bigint; readonly y: bigint; readonly pos: Pos }
  | { readonly kind: 'rel'; readonly dir: Direction; readonly of: Ref; readonly align?: { readonly edge: Edge; readonly pos: Pos }; readonly pos: Pos };

export interface Layer {
  readonly fn: string;
  readonly thickness: bigint;
}

export interface BriefItem {
  readonly handle: string;
  readonly name: string;
  readonly fn: string | undefined;
  readonly count: number;
  readonly target?: bigint;
  readonly min?: bigint;
  readonly level?: Ref;
  readonly pos: Pos;
}

export type Statement =
  | { readonly kind: 'units'; readonly system: UnitSystem; readonly pos: Pos }
  | { readonly kind: 'project'; readonly name: string; readonly pos: Pos }
  | { readonly kind: 'building'; readonly name: string; readonly pos: Pos }
  | {
      readonly kind: 'level';
      readonly handle: string;
      readonly name: string | undefined;
      readonly elevation?: bigint;
      readonly above?: Ref;
      readonly below?: Ref;
      readonly height: bigint;
      readonly pos: Pos;
    }
  | {
      readonly kind: 'wallType';
      readonly scope: 'exterior' | 'interior';
      readonly id: string | undefined;
      readonly name: string | undefined;
      readonly layers: readonly Layer[];
      readonly justification: Justification;
      readonly pos: Pos;
    }
  | {
      readonly kind: 'room';
      readonly handle: string;
      readonly name: string | undefined;
      readonly width: bigint;
      readonly depth: bigint;
      readonly placements: readonly Placement[];
      readonly fn: string | undefined;
      readonly brief: Ref | undefined;
      readonly level: string;
      readonly pos: Pos;
    }
  | { readonly kind: 'open'; readonly a: Ref; readonly b: Ref; readonly pos: Pos }
  | {
      readonly kind: 'opening';
      readonly what: 'door' | 'window' | 'opening';
      readonly a: Ref;
      readonly b: Ref | undefined;
      readonly side: Side | undefined;
      readonly width: bigint;
      readonly height: bigint;
      readonly sill: bigint;
      readonly at: { readonly length: bigint; readonly from: Side; readonly pos: Pos } | undefined;
      readonly hinge: { readonly side: Side; readonly pos: Pos } | undefined;
      readonly swing: { readonly side?: Side; readonly into?: Ref; readonly pos: Pos } | undefined;
      readonly name: string | undefined;
      readonly pos: Pos;
    }
  | { readonly kind: 'brief'; readonly items: readonly BriefItem[]; readonly pos: Pos }
  | { readonly kind: 'adjacency'; readonly adjacency: AdjacencyKind; readonly a: Ref; readonly b: Ref; readonly pos: Pos };

export interface Program {
  readonly statements: readonly Statement[];
  readonly units: UnitSystem;
}

// ── tokens ─────────────────────────────────────────────────────────────────────

const NUM = String.raw`(?:\d+(?:\.\d+)?|\.\d+)`;
// A foot or inch mark follows its number directly (`12'`, `6"`); a unit word may follow a space. So
// `36 "Front door"` is 36 (feet) and a name, never 36 inches.
const FEET = String.raw`${NUM}(?:'|[ \t]*ft(?![A-Za-z]))`;
const INCH = String.raw`(?:\d+(?:[ \t]+|[ \t]*-[ \t]*)\d+/\d+|\d+/\d+|${NUM})(?:"|[ \t]*in(?![A-Za-z]))`;
const IMPERIAL = String.raw`${FEET}(?:[ \t]*-?[ \t]*${INCH})?|${INCH}`;
const METRIC = String.raw`${NUM}[ \t]*(?:mm|cm|m)(?![A-Za-z])`;
const LENGTH_RE = new RegExp(String.raw`(-?)[ \t]*(?:(${IMPERIAL})|(${METRIC})|(${NUM}))`, 'iy');
const AREA_RE = new RegExp(String.raw`${NUM}[ \t]*(?:(?:mm|cm|m|in|ft)(?:2|²)|sq[ \t]+(?:mm|cm|m|in|ft)(?![A-Za-z]))`, 'iy');
const WORD_RE = /[A-Za-z_][A-Za-z0-9_]*/y;
const ID_RE = /[A-Za-z0-9][A-Za-z0-9._-]{0,63}/y;
const INT_RE = /[0-9]+/y;

/** Words a room handle may not be, because a line starting with one is another statement. */
export const KEYWORDS = new Set(['units', 'project', 'building', 'level', 'wall', 'open', 'door', 'window', 'opening', 'brief', 'adjacent', 'near', 'apart', 'room']);

const SIDES: readonly Side[] = ['north', 'south', 'east', 'west'];
const SIDE_WORDS: Readonly<Record<string, Side>> = { north: 'north', south: 'south', east: 'east', west: 'west', top: 'north', bottom: 'south', left: 'west', right: 'east' };
const DIRECTIONS: readonly Direction[] = ['east-of', 'west-of', 'north-of', 'south-of'];
const JUSTIFICATIONS: Readonly<Record<string, Justification>> = {
  center: 'center',
  centre: 'center',
  'exterior-face': 'exteriorFace',
  'interior-face': 'interiorFace',
  'core-face': 'coreFace',
};
const LAYER_FUNCTIONS = new Set(['core', 'substrate', 'insulation', 'membrane', 'airgap', 'finish']);

/** A cursor over one line. Columns are 1-based and count UTF-16 code units. */
class Cursor {
  i = 0;
  constructor(
    readonly text: string,
    readonly line: number,
    readonly units: UnitSystem,
  ) {}

  pos(at = this.i): Pos {
    return { line: this.line, column: at + 1 };
  }
  ws(): void {
    while (this.i < this.text.length && (this.text[this.i] === ' ' || this.text[this.i] === '\t')) this.i++;
  }
  end(): boolean {
    this.ws();
    return this.i >= this.text.length;
  }
  fail(message: string, at = this.i): never {
    throw new DslError(message, this.pos(at));
  }
  /** What is at the cursor, for an error message. */
  rest(): string {
    const r = this.text.slice(this.i).trim();
    const w = /^\S+/.exec(r);
    return w ? w[0] : 'the end of the line';
  }
  private sticky(re: RegExp): RegExpExecArray | null {
    this.ws();
    re.lastIndex = this.i;
    const m = re.exec(this.text);
    return m && m.index === this.i ? m : null;
  }
  /** A keyword (letters and hyphens, case-insensitive) that ends at a non-word character. */
  peekKeyword(...kws: string[]): string | undefined {
    this.ws();
    for (const kw of kws) {
      const s = this.text.slice(this.i, this.i + kw.length);
      const after = this.text[this.i + kw.length];
      if (s.toLowerCase() === kw && (after === undefined || !/[A-Za-z0-9_-]/.test(after))) return kw;
    }
    return undefined;
  }
  keyword(...kws: string[]): string | undefined {
    const k = this.peekKeyword(...kws);
    if (k !== undefined) this.i += k.length;
    return k;
  }
  expectKeyword(...kws: string[]): string {
    const k = this.keyword(...kws);
    if (k === undefined) this.fail(`expected ${kws.map((x) => `"${x}"`).join(' or ')}, found "${this.rest()}"`);
    return k;
  }
  char(c: string): boolean {
    this.ws();
    if (this.text[this.i] !== c) return false;
    this.i++;
    return true;
  }
  word(): string | undefined {
    const m = this.sticky(WORD_RE);
    if (!m) return undefined;
    this.i += m[0].length;
    return m[0];
  }
  quoted(): string | undefined {
    this.ws();
    if (this.text[this.i] !== '"') return undefined;
    const start = this.i;
    let out = '';
    let j = this.i + 1;
    for (; j < this.text.length; j++) {
      const c = this.text[j]!;
      if (c === '\\' && j + 1 < this.text.length) {
        out += this.text[++j] ?? '';
        continue;
      }
      if (c === '"') break;
      out += c;
    }
    if (j >= this.text.length) this.fail('this quoted name is not closed', start);
    this.i = j + 1;
    if (out.length === 0 || out.length > 200) this.fail('a name is 1 to 200 characters', start);
    return out;
  }
  /** A handle: a word that is not a keyword, or a quoted name. */
  ref(what: string): Ref {
    this.ws();
    const at = this.pos();
    const q = this.text[this.i] === '"' ? this.quoted() : undefined;
    if (q !== undefined) return { name: q, pos: at };
    const w = this.word();
    if (w === undefined) this.fail(`expected ${what}, found "${this.rest()}"`);
    return { name: w, pos: at };
  }
  side(): Side | undefined {
    const k = this.keyword(...Object.keys(SIDE_WORDS));
    return k === undefined ? undefined : SIDE_WORDS[k];
  }
  /** A length (3.1), or a bare number in the plan's unit — feet, or metres under `units metric`. */
  length(what: string): bigint {
    this.ws();
    const start = this.i;
    LENGTH_RE.lastIndex = this.i;
    const m = LENGTH_RE.exec(this.text);
    if (!m || m.index !== this.i || m[0].trim() === '-' || m[0].trim() === '') this.fail(`expected ${what}, found "${this.rest()}"`);
    this.i += m[0].length;
    const text = m[4] !== undefined ? `${m[1] ?? ''}${m[4]} ${this.units === 'metric' ? 'm' : 'ft'}` : m[0];
    const p = parseLength(text);
    if (!p.ok) this.fail(`${what}: ${p.reason}`, start);
    return p.value;
  }
  positiveLength(what: string): bigint {
    const at = this.i;
    const v = this.length(what);
    if (v <= 0n) this.fail(`${what} must be greater than zero`, at);
    return v;
  }
  /** `<length> x <length>` (or `×`). */
  size(what: string): [bigint, bigint] {
    const w = this.positiveLength(`${what}'s width`);
    this.ws();
    const c = this.text[this.i];
    if (c !== 'x' && c !== 'X' && c !== '×') this.fail(`expected "x" between the two dimensions of ${what}, found "${this.rest()}"`);
    this.i++;
    const h = this.positiveLength(`${what}'s depth`);
    return [w, h];
  }
  point(): [bigint, bigint] {
    const x = this.length('an x coordinate');
    if (!this.char(',')) this.fail(`expected "," between the two coordinates, found "${this.rest()}"`);
    const y = this.length('a y coordinate');
    return [x, y];
  }
  area(what: string): bigint | undefined {
    const m = this.sticky(AREA_RE);
    if (!m) return undefined;
    const at = this.i;
    this.i += m[0].length;
    const a = parseArea(m[0]);
    if (!a.ok) this.fail(`${what}: ${a.reason}`, at);
    return a.value;
  }
  int(): number | undefined {
    const m = this.sticky(INT_RE);
    if (!m) return undefined;
    // A count is a whole number followed by a word, not the start of a length.
    const after = this.text[this.i + m[0].length];
    if (after !== undefined && after !== ' ' && after !== '\t') return undefined;
    this.i += m[0].length;
    return Number(m[0]);
  }
  id(): string | undefined {
    const m = this.sticky(ID_RE);
    if (!m) return undefined;
    this.i += m[0].length;
    return m[0];
  }
}

/** Strip a `#` comment, outside quotes. */
function stripComment(line: string): string {
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && inQ) {
      i++;
      continue;
    }
    if (c === '"') {
      // A `"` straight after a digit or fraction is an inch mark, not a quote.
      if (!inQ && i > 0 && /[0-9]/.test(line[i - 1]!)) continue;
      inQ = !inQ;
    } else if (c === '#' && !inQ) return line.slice(0, i);
  }
  return line;
}

const DEFAULT_LEVEL_HEIGHT: Readonly<Record<UnitSystem, string>> = { imperial: "9'", metric: '2.7 m' };
export const DEFAULT_DOOR_HEIGHT: Readonly<Record<UnitSystem, string>> = { imperial: '80"', metric: '2100 mm' };
export const DEFAULT_SILL: Readonly<Record<UnitSystem, string>> = { imperial: "3'", metric: '900 mm' };
const fixed = (s: string): bigint => {
  const p = parseLength(s);
  if (!p.ok) throw new Error(`internal: ${s}`);
  return p.value;
};

/** The implicit level, for a plan that draws rooms before it names one. */
export const IMPLICIT_LEVEL = 'main';

/**
 * Parse a whole text. Every line is parsed even after an error, so one pass reports every
 * syntax error; `errors` is empty when the text parsed.
 */
export function parse(text: string): { program: Program; errors: DslError[] } {
  const statements: Statement[] = [];
  const errors: DslError[] = [];
  let units: UnitSystem = 'imperial';
  let unitsFixed = false;
  let level: string | undefined;
  const lines = text.split(/\r\n|\n|\r/);
  for (let n = 0; n < lines.length; n++) {
    const raw = stripComment(lines[n]!);
    if (raw.trim() === '') continue;
    const c = new Cursor(raw, n + 1, units);
    try {
      const s = statement(c, level);
      if (s.kind === 'units') {
        if (unitsFixed) c.fail('"units" comes once, before any length', 0);
        units = s.system;
      }
      if (s.kind !== 'units' && s.kind !== 'project' && s.kind !== 'building') unitsFixed = true;
      if (s.kind === 'level') level = s.handle;
      if (s.kind === 'room' && level === undefined) level = IMPLICIT_LEVEL;
      statements.push(s);
    } catch (e) {
      if (e instanceof DslError) errors.push(e);
      else throw e;
    }
  }
  return { program: { statements, units }, errors };
}

function statement(c: Cursor, level: string | undefined): Statement {
  c.ws();
  const pos = c.pos();
  const kw = c.peekKeyword(...KEYWORDS);
  const brief = c.text.slice(c.i).match(/^brief\s*:/i);
  if (brief) {
    c.i += brief[0].length;
    return briefStatement(c, pos);
  }
  switch (kw) {
    case 'units': {
      c.keyword('units');
      const u = c.expectKeyword('imperial', 'metric') as UnitSystem;
      done(c);
      return { kind: 'units', system: u, pos };
    }
    case 'project':
    case 'building': {
      c.keyword(kw);
      const name = c.quoted() ?? c.word();
      if (name === undefined) c.fail(`expected the ${kw}'s name`);
      done(c);
      return { kind: kw, name, pos };
    }
    case 'level':
      return levelStatement(c, pos);
    case 'wall':
      return wallStatement(c, pos);
    case 'open': {
      c.keyword('open');
      const [a, b] = pair(c, 'two rooms, as "kitchen-dining"');
      if (b === undefined) c.fail('"open" names two rooms: open kitchen-dining');
      done(c);
      return { kind: 'open', a, b, pos };
    }
    case 'door':
    case 'window':
    case 'opening':
      return openingStatement(c, kw, pos);
    case 'adjacent':
    case 'near':
    case 'apart': {
      c.keyword(kw);
      const [a, b] = pair(c, 'two brief items');
      if (b === undefined) c.fail(`"${kw}" names two brief items: ${kw} kitchen dining`);
      done(c);
      const adjacency: AdjacencyKind = kw === 'adjacent' ? 'required' : kw === 'near' ? 'preferred' : 'forbidden';
      return { kind: 'adjacency', adjacency, a, b, pos };
    }
    case 'room':
      c.keyword('room');
      return roomStatement(c, pos, level ?? IMPLICIT_LEVEL);
    case 'brief':
      return c.fail('write "brief:" with a colon, then the items: brief: 3 bed, 2 bath, office');
    default:
      return roomStatement(c, pos, level ?? IMPLICIT_LEVEL);
  }
}

function done(c: Cursor): void {
  if (!c.end()) c.fail(`unexpected "${c.rest()}"`);
}

/** `a-b`, `a b`, or `a` alone (then the second is undefined). Quoted names may be used on either side. */
function pair(c: Cursor, what: string): [Ref, Ref | undefined] {
  const a = c.ref(what);
  c.ws();
  if (c.text[c.i] === '-' && !/[0-9.]/.test(c.text[c.i + 1] ?? '')) {
    c.i++;
    return [a, c.ref(what)];
  }
  return [a, undefined];
}

function levelStatement(c: Cursor, pos: Pos): Statement {
  c.keyword('level');
  const handleRef = c.ref('the level\'s name');
  const quotedHandle = c.text[handleRef.pos.column - 1] === '"';
  let name = quotedHandle ? handleRef.name : undefined;
  let elevation: bigint | undefined;
  let above: Ref | undefined;
  let below: Ref | undefined;
  let height: bigint | undefined;
  while (!c.end()) {
    const at = c.i;
    const q = c.quoted();
    if (q !== undefined) {
      if (name !== undefined && !quotedHandle) c.fail('the level already has a name', at);
      name = q;
      continue;
    }
    const k = c.keyword('at', 'above', 'below', 'height');
    if (k === undefined) c.fail(`unexpected "${c.rest()}"; a level takes at <elevation>, above <level>, below <level> and height <length>`);
    if ((k === 'at' || k === 'above' || k === 'below') && (elevation !== undefined || above !== undefined || below !== undefined))
      c.fail('a level is placed once: at <elevation>, above <level> or below <level>', at);
    if (k === 'at') elevation = c.length('the level\'s elevation');
    else if (k === 'above') above = c.ref('a level');
    else if (k === 'below') below = c.ref('a level');
    else {
      if (height !== undefined) c.fail('the level already has a height', at);
      height = c.positiveLength('the level\'s height');
    }
  }
  return {
    kind: 'level',
    handle: handleRef.name,
    name,
    ...(elevation !== undefined && { elevation }),
    ...(above !== undefined && { above }),
    ...(below !== undefined && { below }),
    height: height ?? fixed(DEFAULT_LEVEL_HEIGHT[c.units]),
    pos,
  };
}

function wallStatement(c: Cursor, pos: Pos): Statement {
  c.keyword('wall');
  const scope = c.expectKeyword('exterior', 'interior') as 'exterior' | 'interior';
  let id: string | undefined;
  let name: string | undefined;
  // An optional type ID, then an optional name, then a colon or `=` before layers.
  c.ws();
  if (!/[0-9.\-"]/.test(c.text[c.i] ?? '') && !c.peekKeyword(...LAYER_FUNCTIONS)) {
    const at = c.i;
    id = c.id();
    if (id === undefined) c.fail(`expected a wall type ID, a name or the layers, found "${c.rest()}"`, at);
  }
  c.ws();
  // A `"` here opens a name unless it is an inch mark: names start with a letter or a digit followed by text.
  if (c.text[c.i] === '"') name = c.quoted();
  if (!c.char(':')) c.char('=');
  const layers: Layer[] = [];
  let justification: Justification = 'center';
  const first = c.i;
  c.ws();
  if (!c.peekKeyword(...LAYER_FUNCTIONS)) {
    layers.push({ fn: 'core', thickness: c.positiveLength('the wall\'s thickness') });
  } else {
    for (;;) {
      const fnAt = c.i;
      const fn = c.keyword(...LAYER_FUNCTIONS);
      if (fn === undefined) c.fail(`expected a layer function (core, substrate, insulation, membrane, airGap, finish), found "${c.rest()}"`, fnAt);
      layers.push({ fn: fn === 'airgap' ? 'airGap' : fn, thickness: c.positiveLength(`the ${fn} layer's thickness`) });
      if (!c.char(',')) break;
    }
  }
  if (layers.length === 0) c.fail('a wall has at least one layer', first);
  if (c.keyword('justify', 'justified')) {
    const k = c.expectKeyword(...Object.keys(JUSTIFICATIONS));
    justification = JUSTIFICATIONS[k]!;
  }
  done(c);
  return { kind: 'wallType', scope, id, name, layers, justification, pos };
}

function roomStatement(c: Cursor, pos: Pos, level: string): Statement {
  const handleAt = c.i;
  c.ws();
  const quotedHandle = c.text[c.i] === '"';
  const handle = c.ref('a room, a level, or another statement');
  if (!quotedHandle && KEYWORDS.has(handle.name.toLowerCase())) c.fail(`"${handle.name}" is a keyword; write "room ${handle.name} …" to use it as a room`, handleAt);
  let name = quotedHandle ? handle.name : c.quoted();
  c.ws();
  if (name === undefined && /[A-Za-z]/.test(c.text[c.i] ?? '')) c.fail(`expected the room's size, as 14x12, found "${c.rest()}"`);
  const [width, depth] = c.size(`room ${handle.name}`);
  const placements: Placement[] = [];
  let fn: string | undefined;
  let brief: Ref | undefined;
  while (!c.end()) {
    const at = c.i;
    const q = c.quoted();
    if (q !== undefined) {
      if (name !== undefined) c.fail('the room already has a name', at);
      name = q;
      continue;
    }
    const k = c.keyword('at', ...DIRECTIONS, 'as', 'for');
    if (k === undefined) c.fail(`unexpected "${c.rest()}"; a room takes at <x>,<y>, east-of/west-of/north-of/south-of <room> [aligned <edge>], as <function> and for <brief item>`);
    if (k === 'at') {
      const [x, y] = c.point();
      placements.push({ kind: 'at', x, y, pos: c.pos(at) });
    } else if (k === 'as') {
      if (fn !== undefined) c.fail('the room already has a function', at);
      const w = c.text.slice(c.i).match(/^[ \t]*([A-Za-z][A-Za-z0-9_]*(?::[a-z][A-Za-z0-9]*)?)/);
      if (!w) c.fail(`expected a room function after "as", found "${c.rest()}"`);
      c.i += w[0].length;
      fn = w[1]!;
    } else if (k === 'for') {
      if (brief !== undefined) c.fail('the room already fulfils a brief item', at);
      brief = c.ref('a brief item');
    } else {
      const of = c.ref('a room');
      let align: { edge: Edge; pos: Pos } | undefined;
      const alignAt = c.i;
      if (c.keyword('aligned', 'align')) {
        c.ws();
        const edgeAt = c.pos();
        const centre = c.keyword('center', 'centre', 'middle');
        const edge: Edge | undefined = centre !== undefined ? 'center' : c.side();
        if (edge === undefined) c.fail(`expected an edge after "aligned" — north, south, east, west (top, bottom, left, right) or center — found "${c.rest()}"`);
        const horizontal = k === 'east-of' || k === 'west-of';
        if (edge !== 'center' && (horizontal ? edge === 'east' || edge === 'west' : edge === 'north' || edge === 'south'))
          c.fail(`a room ${k} another is aligned on its ${horizontal ? 'north, south' : 'east, west'} or center edge, not ${edge}`, alignAt);
        align = { edge, pos: edgeAt };
      }
      placements.push({ kind: 'rel', dir: k as Direction, of, ...(align && { align }), pos: c.pos(at) });
    }
  }
  return { kind: 'room', handle: handle.name, name, width, depth, placements, fn, brief, level, pos };
}

function openingStatement(c: Cursor, what: 'door' | 'window' | 'opening', pos: Pos): Statement {
  c.keyword(what);
  const [a, b] = pair(c, 'a room, or two rooms as "kitchen-dining"');
  let side: Side | undefined;
  if (b === undefined) {
    side = c.side();
    if (side === undefined) c.fail(`a ${what} is between two rooms (${what} kitchen-dining …) or on an outside side of one (${what} kitchen north …); found "${c.rest()}"`);
  }
  let width: bigint;
  let height: bigint | undefined;
  if (what === 'window') {
    [width, height] = c.size('the window');
  } else {
    width = c.positiveLength(`the ${what}'s width`);
    c.ws();
    const ch = c.text[c.i];
    if (ch === 'x' || ch === 'X' || ch === '×') {
      c.i++;
      height = c.positiveLength(`the ${what}'s height`);
    }
  }
  let sill: bigint | undefined;
  let at: { length: bigint; from: Side; pos: Pos } | undefined;
  let hinge: { side: Side; pos: Pos } | undefined;
  let swing: { side?: Side; into?: Ref; pos: Pos } | undefined;
  let name: string | undefined;
  while (!c.end()) {
    const kwAt = c.i;
    const q = c.quoted();
    if (q !== undefined) {
      if (name !== undefined) c.fail(`the ${what} already has a name`, kwAt);
      name = q;
      continue;
    }
    const k = c.keyword('at', 'sill', 'hinge', 'swing');
    if (k === undefined) c.fail(`unexpected "${c.rest()}"; a ${what} takes at <length> from <side>${what === 'window' ? ', sill <length>' : what === 'door' ? ', hinge <side>, swing <side> or swing into <room>' : ''} and a "name"`);
    if (k === 'at') {
      if (at !== undefined) c.fail(`the ${what} is already placed`, kwAt);
      const length = c.length('the distance');
      c.expectKeyword('from');
      const from = c.side();
      if (from === undefined) c.fail(`expected a side after "from" — north, south, east or west — found "${c.rest()}"`);
      at = { length, from, pos: c.pos(kwAt) };
    } else if (k === 'sill') {
      if (what !== 'window' && what !== 'opening') c.fail('only a window or an opening has a sill', kwAt);
      sill = c.length('the sill height');
      if (sill < 0n) c.fail('a sill is not negative', kwAt);
    } else if (k === 'hinge') {
      if (what !== 'door') c.fail('only a door has a hinge', kwAt);
      const s = c.side();
      if (s === undefined) c.fail(`expected a side after "hinge", found "${c.rest()}"`);
      hinge = { side: s, pos: c.pos(kwAt) };
    } else {
      if (what !== 'door') c.fail('only a door swings', kwAt);
      if (c.keyword('into')) swing = { into: c.ref('a room'), pos: c.pos(kwAt) };
      else {
        const s = c.side();
        if (s === undefined) c.fail(`expected a side or "into <room>" after "swing", found "${c.rest()}"`);
        swing = { side: s, pos: c.pos(kwAt) };
      }
    }
  }
  const units = c.units;
  return {
    kind: 'opening',
    what,
    a,
    b,
    side,
    width,
    height: height ?? fixed(DEFAULT_DOOR_HEIGHT[units]),
    sill: what === 'window' ? (sill ?? fixed(DEFAULT_SILL[units])) : (sill ?? 0n),
    at,
    hinge,
    swing,
    name,
    pos,
  };
}

function briefStatement(c: Cursor, pos: Pos): Statement {
  const items: BriefItem[] = [];
  for (;;) {
    c.ws();
    const itemPos = c.pos();
    const count = c.int() ?? 1;
    if (count < 1) c.fail('a count is at least 1', itemPos.column - 1);
    c.ws();
    const quoted = c.text[c.i] === '"';
    const head = c.ref('a brief item, as "3 bed" or "office"');
    let fn: string | undefined;
    let target: bigint | undefined;
    let min: bigint | undefined;
    let level: Ref | undefined;
    let name: string | undefined = quoted ? head.name : undefined;
    for (;;) {
      c.ws();
      if (c.i >= c.text.length || c.text[c.i] === ',') break;
      const at = c.i;
      const q = c.quoted();
      if (q !== undefined) {
        if (name !== undefined) c.fail('the item already has a name', at);
        name = q;
        continue;
      }
      if (c.keyword('as')) {
        const w = c.text.slice(c.i).match(/^[ \t]*([A-Za-z][A-Za-z0-9_]*(?::[a-z][A-Za-z0-9]*)?)/);
        if (!w) c.fail(`expected a room function after "as", found "${c.rest()}"`);
        c.i += w[0].length;
        fn = w[1]!;
        continue;
      }
      if (c.keyword('min')) {
        const a = c.area('the least area');
        if (a === undefined) c.fail(`expected an area after "min", as 100 sq ft or 9 m2, found "${c.rest()}"`);
        min = a;
        continue;
      }
      if (c.keyword('on')) {
        level = c.ref('a level');
        continue;
      }
      const a = c.area('the target area');
      if (a !== undefined) {
        if (target !== undefined) c.fail('the item already has a target area', at);
        target = a;
        continue;
      }
      c.fail(`unexpected "${c.rest()}" in a brief item; an item is [count] <name> [<area>] [min <area>] [on <level>] [as <function>]`);
    }
    items.push({
      handle: head.name,
      name: name ?? head.name,
      fn,
      count,
      ...(target !== undefined && { target }),
      ...(min !== undefined && { min }),
      ...(level !== undefined && { level }),
      pos: itemPos,
    });
    if (!c.char(',')) break;
  }
  done(c);
  return { kind: 'brief', items, pos };
}

export { SIDES };
