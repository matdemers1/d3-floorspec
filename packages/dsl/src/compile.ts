/**
 * The compiler: DSL text → one Floorspec Ops 0.3 batch (FLR-ADR-008: every change is an op).
 *
 *   parse → resolve rooms to rectangles → the plane graph of each level → the batch:
 *   the project's name, a building and its levels (addLevel), the wall and opening types it uses
 *   (addElement), a drawWall for every wall piece (exterior walls clockwise) and a drawSeparator for
 *   every open boundary, the program's items and adjacencies (addProgramItem, setAdjacency), a room
 *   on every rectangle (addRoom), and the openings (addOpening on `wall between A and B` or
 *   `<side> wall of A`, relative references the applier resolves).
 *
 * Deterministic: the same text and base give the same batch, byte for byte. Exact: every coordinate
 * is an integer of base units and nothing is a float.
 */
import { formatLength, parseLength, PREFIX, type Operation } from '@floorspec/ops';
import { parseJson } from '@floorspec/engine';
import { DslError, type DslDiagnostic, type Pos } from './diagnostics.js';
import { inferFunction, isFunctionTerm, itemName, nameFromHandle } from './functions.js';
import { oriented, pieces, resolveRects, sidePieces, sideOfVector, type Piece, type Rect, type RoomSpec } from './layout.js';
import { IMPLICIT_LEVEL, parse, type BriefItem, type Justification, type Layer, type Side, type Statement, type UnitSystem } from './syntax.js';

type Json = Record<string, unknown>;
type Of<K extends Statement['kind']> = Extract<Statement, { kind: K }>;

export interface CompileOptions {
  /**
   * The document the batch will be applied to (default: an empty Core 0.3 document). Only read:
   * the batch mints IDs that are free in it, and adds its levels to its building when it has
   * exactly one.
   */
  readonly base?: string | Uint8Array | object;
}

export interface Compiled {
  readonly ok: true;
  /** The Ops 0.3 request's batch. */
  readonly batch: Operation[];
  /** For each operation of the batch, the line that made it. */
  readonly sources: Pos[];
  /** For each ID the batch names, the line that made it. */
  readonly elements: ReadonlyMap<string, Pos>;
  /** Room handle (lower case) → room ID. */
  readonly rooms: ReadonlyMap<string, string>;
  readonly warnings: DslDiagnostic[];
}

export interface CompileFailure {
  readonly ok: false;
  readonly diagnostics: DslDiagnostic[];
}

export type CompileResult = Compiled | CompileFailure;

const MAX = 9007199254740991n;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const lc = (s: string): string => s.toLowerCase();

/** IDs minted as Ops 1.5 mints them: the prefix and one more than the largest number in use. */
class Ids {
  private readonly next = new Map<string, number>();
  constructor(readonly used: Set<string>) {}
  mint(prefix: string): string {
    let n = this.next.get(prefix);
    if (n === undefined) {
      n = 0;
      const re = new RegExp(`^${prefix}([0-9]+)$`);
      for (const id of this.used) {
        const m = re.exec(id);
        if (m) n = Math.max(n, Number(m[1]));
      }
    }
    n++;
    this.next.set(prefix, n);
    const id = `${prefix}${String(n)}`;
    this.used.add(id);
    return id;
  }
  take(id: string): boolean {
    if (this.used.has(id)) return false;
    this.used.add(id);
    return true;
  }
}

/** The collections of a Core document whose members are IDs (Core §3.1). */
const COLLECTIONS = ['buildings', 'levels', 'junctions', 'walls', 'separators', 'openings', 'rooms', 'slabs', 'types', 'materials', 'assets', 'roofs', 'stairs'] as const;

function baseDocument(input: CompileOptions['base']): Json {
  if (input === undefined) return { floorspec: '0.3', project: { name: 'Untitled' } };
  const v: unknown = typeof input === 'string' || input instanceof Uint8Array ? parseJson(input).value : input;
  if (!isObject(v)) throw new DslError('the base document is not a JSON object', { line: 1, column: 1 }, 'FS-DSL-REFERENCE');
  return v;
}

function idsOf(doc: Json): Set<string> {
  const out = new Set<string>();
  for (const c of COLLECTIONS) if (isObject(doc[c])) for (const id of Object.keys(doc[c])) out.add(id);
  const program = doc['program'];
  if (isObject(program) && isObject(program['items'])) for (const id of Object.keys(program['items'])) out.add(id);
  const ext = doc['extensions'];
  if (isObject(ext))
    for (const e of Object.values(ext))
      if (isObject(e) && isObject(e['collections'])) for (const coll of Object.values(e['collections'])) if (isObject(coll)) for (const id of Object.keys(coll)) out.add(id);
  return out;
}

const num = (v: bigint, pos: Pos, what: string): number => {
  if (v > MAX || v < -MAX) throw new DslError(`${what} is out of range`, pos, 'FS-DSL-LAYOUT');
  return Number(v);
};

/** Half of v, rounded ties to even (Ops 3.5 rounds a centred position this way). */
export function halfEven(v: bigint): bigint {
  const f = floorHalf(v);
  if (v % 2n === 0n) return f;
  return f % 2n === 0n ? f : f + 1n;
}

const DEFAULT_WALLS: Readonly<Record<UnitSystem, Readonly<Record<'exterior' | 'interior', string>>>> = {
  imperial: { exterior: '6"', interior: '4 1/2"' },
  metric: { exterior: '150 mm', interior: '100 mm' },
};

/** Compile a DSL text to an Ops 0.3 batch. Never throws for a bad text: errors come back as diagnostics. */
export function compile(text: string, options: CompileOptions = {}): CompileResult {
  const { program, errors } = parse(text);
  if (errors.length > 0) return { ok: false, diagnostics: errors.map((e) => e.toDiagnostic()) };
  try {
    return new Compiler(program.statements, program.units, baseDocument(options.base)).run();
  } catch (e) {
    if (e instanceof DslError) return { ok: false, diagnostics: [e.toDiagnostic()] };
    throw e;
  }
}

interface LevelInfo {
  readonly id: string;
  readonly handle: string;
  readonly name: string;
  readonly stmt: Of<'level'> | undefined;
}

interface RoomInfo {
  readonly key: string;
  readonly id: string;
  readonly stmt: Of<'room'>;
  readonly name: string;
  readonly level: LevelInfo;
  rect?: Rect;
}

interface WallInfo {
  readonly id: string;
  readonly piece: Piece;
  readonly from: readonly [bigint, bigint];
  readonly to: readonly [bigint, bigint];
  readonly separator: boolean;
}

class Compiler {
  private readonly batch: Operation[] = [];
  private readonly sources: Pos[] = [];
  private readonly elements = new Map<string, Pos>();
  private readonly warnings: DslDiagnostic[] = [];
  private readonly ids: Ids;
  private readonly levels = new Map<string, LevelInfo>();
  private readonly rooms = new Map<string, RoomInfo>();
  private readonly items = new Map<string, { id: string; item: BriefItem }>();
  private readonly walls = new Map<string, WallInfo[]>(); // by level ID
  private readonly types = new Map<string, string>(); // spec key → type ID
  private readonly wallTypes = new Map<'exterior' | 'interior', { id: string; justification: Justification } | Of<'wallType'>>();
  private readonly baseRoomNames: Set<string>;

  constructor(
    private readonly statements: readonly Statement[],
    private readonly units: UnitSystem,
    private readonly base: Json,
  ) {
    this.ids = new Ids(idsOf(base));
    this.baseRoomNames = new Set(
      Object.values(isObject(base['rooms']) ? base['rooms'] : {})
        .filter(isObject)
        .map((r) => (typeof r['name'] === 'string' ? lc(r['name']) : ''))
        .filter((n) => n !== ''),
    );
  }

  private push(op: Operation, pos: Pos, id?: string): void {
    this.batch.push(op);
    this.sources.push(pos);
    if (id !== undefined) this.elements.set(id, pos);
  }

  private all<K extends Statement['kind']>(kind: K): Of<K>[] {
    return this.statements.filter((s): s is Of<K> => s.kind === kind);
  }

  run(): Compiled {
    this.header();
    this.declareLevels();
    this.declareRooms();
    this.declareWallTypes();
    this.declareItems();
    this.layout();
    this.emitLevels();
    this.emitWalls();
    this.emitItems();
    this.emitRooms();
    this.emitOpenings();
    return {
      ok: true,
      batch: this.batch,
      sources: this.sources,
      elements: this.elements,
      rooms: new Map([...this.rooms].map(([k, r]) => [k, r.id])),
      warnings: this.warnings,
    };
  }

  // ── project, building, levels ────────────────────────────────────────────────

  private buildingId = '';

  private header(): void {
    const projects = this.all('project');
    if (projects.length > 1) throw new DslError('the project is named once', projects[1]!.pos);
    if (projects[0]) this.push({ op: 'setProperty', id: '$project', path: '/name', value: projects[0].name }, projects[0].pos);
    const buildings = this.all('building');
    if (buildings.length > 1) throw new DslError('a plan has one building', buildings[1]!.pos);
    const existing = isObject(this.base['buildings']) ? Object.keys(this.base['buildings']).sort(cmp) : [];
    const anyLevel = this.statements.some((s) => s.kind === 'level' || s.kind === 'room');
    if (existing.length === 1 && !buildings[0]) {
      this.buildingId = existing[0]!;
      return;
    }
    if (!anyLevel && !buildings[0]) return;
    this.buildingId = this.ids.mint(PREFIX.buildings);
    const pos = buildings[0]?.pos ?? { line: 1, column: 1 };
    this.push({ op: 'addElement', collection: 'buildings', id: this.buildingId, element: { name: buildings[0]?.name ?? 'House' } }, pos, this.buildingId);
  }

  private declareLevels(): void {
    for (const s of this.all('level')) {
      const key = lc(s.handle);
      if (this.levels.has(key)) throw new DslError(`level ${s.handle} is declared twice`, s.pos, 'FS-DSL-REFERENCE');
      this.levels.set(key, { id: this.ids.mint(PREFIX.levels), handle: s.handle, name: s.name ?? nameFromHandle(s.handle), stmt: s });
    }
    const needsImplicit = this.all('room').some((r) => r.level === IMPLICIT_LEVEL) && !this.levels.has(IMPLICIT_LEVEL);
    if (needsImplicit) this.levels.set(IMPLICIT_LEVEL, { id: this.ids.mint(PREFIX.levels), handle: 'Main', name: 'Main', stmt: undefined });
  }

  private level(name: string, pos: Pos): LevelInfo {
    const l = this.levels.get(lc(name));
    if (!l) throw new DslError(`there is no level ${name}`, pos, 'FS-DSL-REFERENCE');
    return l;
  }

  private emitLevels(): void {
    let previous: LevelInfo | undefined;
    for (const l of this.levels.values()) {
      const s = l.stmt;
      const pos = s?.pos ?? this.all('room')[0]!.pos;
      const height = s?.height ?? parseLen(this.units === 'metric' ? '2.7 m' : "9'");
      const op: Operation = {
        op: 'addLevel',
        id: l.id,
        building: this.buildingId,
        height: num(height, pos, 'the height'),
        name: l.name,
        ...(s?.elevation !== undefined
          ? { elevation: num(s.elevation, pos, 'the elevation') }
          : s?.above
            ? { above: this.level(s.above.name, s.above.pos).id }
            : s?.below
              ? { below: this.level(s.below.name, s.below.pos).id }
              : previous
                ? { above: previous.id }
                : { elevation: 0 }),
      };
      this.push(op, pos, l.id);
      previous = l;
    }
  }

  // ── rooms and their rectangles ───────────────────────────────────────────────

  private declareRooms(): void {
    for (const s of this.all('room')) {
      const key = lc(s.handle);
      if (this.rooms.has(key)) throw new DslError(`room ${s.handle} is declared twice`, s.pos, 'FS-DSL-REFERENCE');
      if (s.fn !== undefined && !isFunctionTerm(s.fn)) throw new DslError(`"${s.fn}" is not a room function: use one of unspecified, sleeping, bath, kitchen, living, dining, office, laundry, utility, storage, circulation, mechanical, garage, exterior`, s.pos, 'FS-DSL-REFERENCE');
      this.rooms.set(key, { key, id: '', stmt: s, name: s.name ?? nameFromHandle(s.handle), level: this.level(s.level === IMPLICIT_LEVEL ? IMPLICIT_LEVEL : s.level, s.pos) });
    }
    // IDs in order of declaration, after the levels.
    for (const r of this.rooms.values()) (r as { id: string }).id = this.ids.mint(PREFIX.rooms);
  }

  private room(name: string, pos: Pos): RoomInfo {
    const r = this.rooms.get(lc(name));
    if (r) return r;
    const byName = [...this.rooms.values()].filter((x) => lc(x.name) === lc(name));
    if (byName.length === 1) return byName[0]!;
    if (byName.length > 1) throw new DslError(`"${name}" names ${byName.length} rooms (${byName.map((x) => x.stmt.handle).join(', ')}); use a handle`, pos, 'FS-DSL-REFERENCE');
    throw new DslError(`there is no room ${name}`, pos, 'FS-DSL-REFERENCE');
  }

  private layout(): void {
    const specs: RoomSpec[] = [...this.rooms.values()].map((r) => ({
      key: r.key,
      handle: r.stmt.handle,
      width: r.stmt.width,
      depth: r.stmt.depth,
      placements: r.stmt.placements,
      level: r.level.id,
      pos: r.stmt.pos,
    }));
    const rects = resolveRects(specs, (name, pos) => this.room(name, pos).key);
    for (const r of this.rooms.values()) r.rect = rects.get(r.key)!;
  }

  // ── walls ─────────────────────────────────────────────────────────────────────

  private declareWallTypes(): void {
    for (const s of this.all('wallType')) {
      if (this.wallTypes.has(s.scope)) throw new DslError(`the ${s.scope} wall is declared twice`, s.pos);
      if (s.justification === 'coreFace') {
        const cores = s.layers.map((l, i) => (l.fn === 'core' ? i : -1)).filter((i) => i >= 0);
        if (cores.length === 0 || cores[cores.length - 1]! - cores[0]! !== cores.length - 1)
          throw new DslError('a wall justified core-face has one run of core layers', s.pos);
      }
      this.wallTypes.set(s.scope, s);
    }
  }

  private wallType(scope: 'exterior' | 'interior', pos: Pos): { id: string; justification: Justification } {
    const t = this.wallTypes.get(scope);
    if (t && !('kind' in t)) return t;
    const layers: readonly Layer[] = t ? t.layers : [{ fn: 'core', thickness: parseLen(DEFAULT_WALLS[this.units][scope]) }];
    let id: string;
    if (t?.id !== undefined) {
      if (!this.ids.take(t.id)) throw new DslError(`the ID ${t.id} is already in use`, t.pos, 'FS-DSL-REFERENCE');
      id = t.id;
    } else id = this.ids.mint(PREFIX.types);
    const thickness = layers.reduce((s, l) => s + l.thickness, 0n);
    const name = t?.name ?? `${scope === 'exterior' ? 'Exterior wall' : 'Interior wall'}, ${formatLength(thickness, this.units === 'metric' ? { system: 'metric' } : {})}`;
    const at = t?.pos ?? pos;
    this.push(
      {
        op: 'addElement',
        collection: 'types',
        id,
        element: { kind: 'wallType', name, layers: layers.map((l) => ({ thickness: num(l.thickness, at, 'a layer'), function: l.fn })) },
      },
      at,
      id,
    );
    const resolved = { id, justification: t?.justification ?? 'center' };
    this.wallTypes.set(scope, resolved);
    return resolved;
  }

  private emitWalls(): void {
    const separatorsWanted = new Map<string, Of<'open'>>(); // piece key → statement
    const byLevel = new Map<string, RoomInfo[]>();
    for (const r of this.rooms.values()) byLevel.set(r.level.id, [...(byLevel.get(r.level.id) ?? []), r]);
    const levelPieces = new Map<string, Piece[]>();
    for (const [lid, rooms] of byLevel) levelPieces.set(lid, pieces(new Map(rooms.map((r) => [r.key, r.rect!]))));
    for (const s of this.all('open')) {
      const a = this.room(s.a.name, s.a.pos);
      const b = this.room(s.b.name, s.b.pos);
      const p = this.between(levelPieces, a, b, s.pos);
      separatorsWanted.set(`${a.level.id}|${p.axis}:${p.at}:${p.lo}`, s);
    }
    for (const [lid, ps] of levelPieces) {
      const list: WallInfo[] = [];
      // Walls first, then separators, each in plane-graph order.
      for (const separator of [false, true]) {
        for (const p of ps) {
          const open = separatorsWanted.get(`${lid}|${p.axis}:${p.at}:${p.lo}`);
          if ((open !== undefined) !== separator) continue;
          const exterior = p.high === undefined || p.low === undefined;
          const { from, to } = oriented(p);
          const someRoom = this.byKey(p.high ?? p.low!);
          const pos = open?.pos ?? someRoom.stmt.pos;
          const P = (q: readonly [bigint, bigint]): [number, number] => [num(q[0], pos, 'a coordinate'), num(q[1], pos, 'a coordinate')];
          if (separator) {
            const id = this.ids.mint(PREFIX.separators);
            this.push({ op: 'drawSeparator', id, level: lid, from: P(from), to: P(to) }, pos, id);
            list.push({ id, piece: p, from, to, separator: true });
          } else {
            const t = this.wallType(exterior ? 'exterior' : 'interior', pos);
            const id = this.ids.mint(PREFIX.walls);
            this.push({ op: 'drawWall', id, level: lid, from: P(from), to: P(to), type: t.id, ...(t.justification !== 'center' && { justification: t.justification }) }, pos, id);
            list.push({ id, piece: p, from, to, separator: false });
          }
        }
      }
      this.walls.set(lid, list);
    }
  }

  private byKey(key: string): RoomInfo {
    return this.rooms.get(key)!;
  }

  /** The one piece two rooms share. */
  private between(levelPieces: ReadonlyMap<string, Piece[]>, a: RoomInfo, b: RoomInfo, pos: Pos): Piece {
    if (a.key === b.key) throw new DslError(`a boundary is between two different rooms`, pos, 'FS-DSL-LAYOUT');
    if (a.level.id !== b.level.id) throw new DslError(`rooms ${a.stmt.handle} and ${b.stmt.handle} are on different levels`, pos, 'FS-DSL-LAYOUT');
    const p = levelPieces.get(a.level.id)!.find((x) => (x.high === a.key && x.low === b.key) || (x.high === b.key && x.low === a.key));
    if (!p) throw new DslError(`rooms ${a.stmt.handle} and ${b.stmt.handle} do not share a wall`, pos, 'FS-DSL-LAYOUT');
    return p;
  }

  // ── the brief ─────────────────────────────────────────────────────────────────

  private declareItems(): void {
    for (const s of this.all('brief'))
      for (const item of s.items) {
        const key = lc(item.handle);
        if (this.items.has(key)) throw new DslError(`the brief already has ${item.handle}`, item.pos, 'FS-DSL-REFERENCE');
        if (item.fn !== undefined && !isFunctionTerm(item.fn)) throw new DslError(`"${item.fn}" is not a room function`, item.pos, 'FS-DSL-REFERENCE');
        this.items.set(key, { id: this.ids.mint(PREFIX.items), item });
      }
  }

  private item(name: string, pos: Pos): string {
    const hit = this.items.get(lc(name)) ?? [...this.items.values()].find((x) => lc(x.item.name) === lc(name));
    if (!hit) throw new DslError(`the brief has no item ${name}`, pos, 'FS-DSL-REFERENCE');
    return hit.id;
  }

  private emitItems(): void {
    for (const { id, item } of this.items.values()) {
      const fn = item.fn ?? inferFunction(item.handle, item.name);
      if (item.fn === undefined && fn === 'unspecified')
        this.warnings.push({ code: 'FS-DSL-REFERENCE', severity: 'warning', message: `the function of brief item ${item.handle} is not known: it is unspecified; say "as <function>"`, line: item.pos.line, column: item.pos.column });
      const name = item.name !== item.handle ? item.name : itemName(item.handle);
      this.push(
        {
          op: 'addProgramItem',
          id,
          function: fn,
          name,
          ...(item.count !== 1 && { count: item.count }),
          ...(item.target !== undefined && { targetArea: num(item.target, item.pos, 'the area') }),
          ...(item.min !== undefined && { minArea: num(item.min, item.pos, 'the area') }),
          ...(item.level && { level: this.level(item.level.name, item.level.pos).id }),
        },
        item.pos,
        id,
      );
    }
    for (const s of this.all('adjacency')) {
      const a = this.item(s.a.name, s.a.pos);
      const b = this.item(s.b.name, s.b.pos);
      if (a === b) throw new DslError('an adjacency relates two different items', s.pos, 'FS-DSL-REFERENCE');
      this.push({ op: 'setAdjacency', a, b, kind: s.adjacency }, s.pos);
    }
  }

  // ── rooms ─────────────────────────────────────────────────────────────────────

  private emitRooms(): void {
    for (const r of this.rooms.values()) {
      const s = r.stmt;
      const rect = r.rect!;
      const fn = s.fn ?? inferFunction(r.name, s.handle);
      const at: [number, number] = [num(floorHalf(rect.x0 + rect.x1), s.pos, 'the anchor'), num(floorHalf(rect.y0 + rect.y1), s.pos, 'the anchor')];
      this.push(
        {
          op: 'addRoom',
          id: r.id,
          level: r.level.id,
          at,
          name: r.name,
          ...(fn !== 'unspecified' && { function: fn }),
          ...(s.brief && { brief: this.item(s.brief.name, s.brief.pos) }),
        },
        s.pos,
        r.id,
      );
    }
  }

  // ── openings ──────────────────────────────────────────────────────────────────

  /** Whether a room's name can be written in a selector: one room has it, and it is no ID. */
  private selectable(r: RoomInfo): boolean {
    const n = lc(r.name);
    if ([...this.rooms.values()].filter((x) => lc(x.name) === n).length !== 1) return false;
    if (this.baseRoomNames.has(n)) return false;
    if (/\band\b/i.test(r.name) || /^(?:north|south|east|west|start|end|item|brief)\b/i.test(r.name)) return false;
    if (/^[A-Z]{1,2}[0-9]+$/i.test(r.name)) return false;
    return ![...this.ids.used].some((id) => id === r.name);
  }

  private emitOpenings(): void {
    for (const s of this.all('opening')) {
      const a = this.room(s.a.name, s.a.pos);
      const walls = this.walls.get(a.level.id)!;
      const levelPieces = new Map([[a.level.id, walls.map((w) => w.piece)]]);
      let candidates: WallInfo[];
      let lo: bigint;
      let hi: bigint;
      let axis: 'h' | 'v';
      let selector: string | undefined;
      const where = s.b ? `between ${a.stmt.handle} and ${s.b.name}` : `on the ${s.side!} side of ${a.stmt.handle}`;
      if (s.b) {
        const b = this.room(s.b.name, s.b.pos);
        const p = this.between(levelPieces, a, b, s.pos);
        const w = walls.find((x) => x.piece === p)!;
        if (w.separator) throw new DslError(`${a.stmt.handle} and ${b.stmt.handle} are open to each other: a ${s.what} needs a wall`, s.pos, 'FS-DSL-LAYOUT');
        candidates = [w];
        ({ lo, hi, axis } = p);
        if (this.selectable(a) && this.selectable(b)) selector = `wall between ${a.name} and ${b.name}`;
      } else {
        const side = s.side!;
        const rect = a.rect!;
        const ps = sidePieces(
          walls.map((w) => w.piece),
          a.key,
          rect,
          side,
        );
        const onSide = walls.filter((w) => ps.includes(w.piece));
        candidates = onSide.filter((w) => !w.separator && (w.piece.high === undefined || w.piece.low === undefined));
        if (candidates.length === 0) throw new DslError(`room ${a.stmt.handle} has no outside wall on its ${side} side`, s.pos, 'FS-DSL-LAYOUT');
        axis = side === 'north' || side === 'south' ? 'h' : 'v';
        lo = axis === 'h' ? rect.x0 : rect.y0;
        hi = axis === 'h' ? rect.x1 : rect.y1;
        if (onSide.filter((w) => !w.separator).length === 1 && this.selectable(a)) selector = `${side} wall of ${a.name}`;
      }
      const width = s.width;
      if (width > hi - lo) throw new DslError(`the ${s.what} is wider than the wall ${where}`, s.pos, 'FS-DSL-LAYOUT');
      let start: bigint;
      if (s.at) {
        const along: readonly Side[] = axis === 'h' ? ['east', 'west'] : ['north', 'south'];
        if (!along.includes(s.at.from)) throw new DslError(`the wall ${where} runs ${axis === 'h' ? 'east–west' : 'north–south'}: measure from its ${along.join(' or ')} end`, s.at.pos, 'FS-DSL-LAYOUT');
        start = s.at.from === 'west' || s.at.from === 'south' ? lo + s.at.length : hi - s.at.length - width;
        if (start < lo || start + width > hi) throw new DslError(`the ${s.what} runs past the end of the wall ${where}`, s.at.pos, 'FS-DSL-LAYOUT');
      } else start = lo + halfEven(hi - lo - width);
      const host = candidates.find((w) => w.piece.lo <= start && start + width <= w.piece.hi);
      if (!host) {
        throw new DslError(
          s.b
            ? `the ${s.what} ${where} crosses a junction; move it with "at <length> from <side>"`
            : `the ${s.what} ${where} is not within one outside wall; move it with "at <length> from <side>"`,
          s.at?.pos ?? s.pos,
          'FS-DSL-LAYOUT',
        );
      }
      const ax = axis === 'h' ? 0 : 1;
      const forward = host.from[ax] < host.to[ax];
      const offset = forward ? start - host.from[ax] : host.from[ax] - (start + width);
      const length = host.piece.hi - host.piece.lo;
      const centred = halfEven(length - width) === offset;
      const dx = host.to[0] - host.from[0];
      const dy = host.to[1] - host.from[1];
      const dir = sideOfVector(dx, dy);
      const left = sideOfVector(-dy, dx);
      let hinge: 'start' | 'end' | undefined;
      if (s.hinge) {
        const h = s.hinge.side;
        if (!sameAxis(h, dir)) throw new DslError(`the wall ${where} runs ${axis === 'h' ? 'east–west' : 'north–south'}: its hinge is at its ${axis === 'h' ? 'east or west' : 'north or south'} end`, s.hinge.pos, 'FS-DSL-LAYOUT');
        hinge = h === dir ? 'end' : 'start';
      }
      let swing: 'left' | 'right' | undefined;
      if (s.swing) {
        let side = s.swing.side;
        if (s.swing.into) {
          const into = this.room(s.swing.into.name, s.swing.into.pos);
          const p = host.piece;
          if (into.key === p.high) side = p.axis === 'h' ? 'north' : 'east';
          else if (into.key === p.low) side = p.axis === 'h' ? 'south' : 'west';
          else throw new DslError(`room ${into.stmt.handle} is not on either side of the wall ${where}`, s.swing.pos, 'FS-DSL-LAYOUT');
        }
        if (sameAxis(side!, dir)) throw new DslError(`a door in the wall ${where} swings ${axis === 'h' ? 'north or south' : 'east or west'}`, s.swing.pos, 'FS-DSL-LAYOUT');
        swing = side === left ? 'left' : 'right';
      }
      const id = this.ids.mint(PREFIX.openings);
      const pos = s.pos;
      const fill = s.what === 'opening' ? undefined : this.openingType(s.what, width, s.height, s.sill, pos);
      this.push(
        {
          op: 'addOpening',
          id,
          wall: selector ?? host.id,
          at: centred ? 'centered' : num(offset, pos, 'the offset'),
          ...(fill !== undefined ? { fill } : { width: num(width, pos, 'the width'), height: num(s.height, pos, 'the height'), ...(s.sill > 0n && { sill: num(s.sill, pos, 'the sill') }) }),
          ...(hinge !== undefined && { hinge }),
          ...(swing !== undefined && { swing }),
          ...(s.name !== undefined && { name: s.name }),
        },
        pos,
        id,
      );
    }
  }

  /** The door or window type of that size, added the first time it is used. */
  private openingType(what: 'door' | 'window', width: bigint, height: bigint, sill: bigint, pos: Pos): string {
    const key = `${what}:${width}:${height}:${sill}`;
    const known = this.types.get(key);
    if (known) return known;
    const IN = 32512n;
    const MM = 1280n;
    const metric = this.units === 'metric';
    const unit = metric ? MM : IN;
    const whole = width % unit === 0n && height % unit === 0n;
    let id: string | undefined;
    if (whole) {
      const w = width / unit;
      const h = height / unit;
      const standard = what === 'door' && height === parseLen(metric ? '2100 mm' : '80"');
      const candidate = what === 'door' ? (standard ? `D${w}` : `D${w}x${h}`) : metric ? `W${w}x${h}` : `W${w}${h}`;
      if (this.ids.take(candidate)) id = candidate;
    }
    id ??= this.ids.mint(PREFIX.types);
    const fmt = (v: bigint): string => formatLength(v, metric ? { system: 'metric' } : {});
    const element: Json =
      what === 'door'
        ? { kind: 'doorType', name: `Door ${fmt(width)} x ${fmt(height)}`, width: num(width, pos, 'the width'), height: num(height, pos, 'the height') }
        : { kind: 'windowType', name: `Window ${fmt(width)} x ${fmt(height)}`, width: num(width, pos, 'the width'), height: num(height, pos, 'the height'), sill: num(sill, pos, 'the sill') };
    this.push({ op: 'addElement', collection: 'types', id, element }, pos, id);
    this.types.set(key, id);
    return id;
  }
}

const sameAxis = (a: Side, b: Side): boolean => (a === 'east' || a === 'west') === (b === 'east' || b === 'west');

/** Floor of v / 2 for any sign. */
function floorHalf(v: bigint): bigint {
  return v >= 0n ? v / 2n : -((-v + 1n) / 2n);
}

function parseLen(s: string): bigint {
  const p = parseLength(s);
  if (!p.ok) throw new Error(`internal: the default length ${s} does not parse`);
  return p.value;
}
