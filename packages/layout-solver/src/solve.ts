/**
 * solve(document, options) → ranked candidate layouts, each a Floorspec Ops batch.
 *
 * 1. Read the program (the document's, or one passed in) and decide the level to draw on.
 * 2. Build every variant of every strategy (builders.ts) as a tiling of rectangles; plan its doors
 *    (access.ts); estimate its score from the rectangles alone.
 * 3. Take the best-estimated distinct tilings, write each as a batch (emit.ts), apply it with
 *    @floorspec/ops and measure the result with @floorspec/engine (measure.ts); score it (score.ts).
 * 4. Return the best `count`, ranked by total score.
 *
 * Two levels (FLR-T-12.16): when the brief's items prefer two empty levels, one directly above the
 * other, and no level is asked for, each candidate lays out both. The lower level is laid out as a
 * single level is; a straight stair is placed in one of its rooms people pass through (stair.ts);
 * the upper level takes the lower level's outline, with the stair's well cut where the engine says
 * the floor must be open (Core 17.6) and the upper rooms either side of a hall the stair arrives in
 * (upper.ts). The two are scored as one house: the stair joins its foot room and its head room, as
 * it does in the door graph (Core 14.1). A candidate whose stair the engine finds short of headroom
 * (FS-LINT-019), or with less than 3' of floor at its foot or head (the engine's landings measure),
 * or whose stair does not join the rooms it was placed between, is dropped. FLR-ADR-050 (proposed).
 *
 * Deterministic: no clock, no Math.random; every enumeration and every tie is broken by a stable
 * key. The same document and options give the same candidates, byte for byte.
 */
import { check, jsonEqual, landings, omitDefaults } from '@floorspec/engine';
import type { Operation } from '@floorspec/ops';
import { fits, planAccess, type Access } from './access.js';
import { variants, type Variant } from './builders.js';
import { collection, idsOf, levelIsEmpty, levelsByElevation, parseDocument, SolverError, type Json } from './document.js';
import { emit, Ids, type Target, type TypeName } from './emit.js';
import { insideOf, isExterior, segments, signature, tiles, type Family, type Layout, type Seg, type Space } from './layout.js';
import { estimate, estimateLevels, measure, type Measures } from './measure.js';
import { grossG, minDim, readBrief, type Brief, type Program, type Req, type Unplaced } from './program.js';
import { describePlacement, dirName, LANDING_CLEAR, placements, profileOf, STAIR, stairElement, toActual, type Dir, type Placement, type Profile } from './stair.js';
import { frameFor, UpperPlanner, type Upper } from './upper.js';
import { pairKey } from './layout.js';
import { Prng } from './random.js';
import { score, type ScoreBreakdown, type ScoreContext } from './score.js';
import { BU_PER_FOOT, BU_PER_INCH, gBu, GRID } from './units.js';

export interface SolveOptions {
  /** The program to lay out. Default: the document's own (Core 0.2 `program`). */
  readonly program?: Program;
  /** An existing, empty level to draw on. Default: the level most items prefer, else the lowest empty level, else a new one. */
  readonly level?: string;
  /** The footprint, in base units (rounded down to the 6-inch grid). Default: sized from the program. */
  readonly footprint?: { readonly width: number; readonly depth: number };
  /** How many candidates to return. Default 5; at least 3 whenever the program allows. */
  readonly count?: number;
  /** IDs the store has retired (Ops 1.5): never named by a candidate. The server knows these. */
  readonly retired?: readonly string[];
  /** Place items that prefer another level on this one anyway. Default false: they are reported as unplaced. */
  readonly ignoreItemLevels?: boolean;
  /** Add windows to habitable rooms' outside walls. Default true. */
  readonly windows?: boolean;
  /**
   * Set each placed room's `brief` in the batch (Ops 0.2). Default true. A program passed in that is
   * not the document's own has no items in the document to name, so its candidates never set it.
   */
  readonly emitBrief?: boolean;
  /**
   * Have no two candidates name the same ID — types, walls, rooms, and the building and level a
   * candidate adds — so that all of them can be proposed as changesets of one project at once: the
   * store retires an ID the first time any head holds it (Ops 1.5). Default false: each candidate
   * mints from the document's state, as if it were the only one.
   */
  readonly distinctIds?: boolean;
  /** How many of the best-estimated tilings are applied and measured in full. Default 10. */
  readonly evaluate?: number;
  /** Seed for the order in which equally-estimated variants are tried. Default 1. */
  readonly seed?: number;
}

export interface CandidateRoom {
  readonly id: string;
  readonly name: string;
  readonly function: string;
  /** The program item it fulfils, if any; halls and closets the solver added have none. */
  readonly item?: string;
  readonly kind: Space['kind'];
  /** [x0, y0, x1, y1] of its centre-line rectangle, base units. */
  readonly rect: readonly [number, number, number, number];
  /** The level it is on. */
  readonly level: string;
  /** Net area, square feet, as the engine derives it. */
  readonly area: number;
}

export interface Candidate {
  /** Stable: the strategy variant that produced it. */
  readonly id: string;
  /** 1 is best. */
  readonly rank: number;
  readonly strategy: Family;
  readonly label: string;
  /** The level laid out — for a two-level candidate, the lower one. */
  readonly level: string;
  /** Every level the candidate lays out, lowest first: `[level]`, or the lower and the upper level. */
  readonly levels: readonly string[];
  /** A two-level candidate's stair, as the engine derives and measures it on the committed document. */
  readonly stair?: CandidateStair;
  /** The Ops batch that draws this layout (and links each room to its item), applied to the document as given. */
  readonly batch: Operation[];
  readonly footprint: { readonly width: number; readonly depth: number };
  readonly rooms: readonly CandidateRoom[];
  /** The room the front door opens into. */
  readonly entry: string;
  readonly unplaced: readonly Unplaced[];
  readonly score: ScoreBreakdown;
  readonly explanation: readonly string[];
}

/** The stair of a two-level candidate (FLR-T-12.16), as the engine derives it from the committed document. */
export interface CandidateStair {
  readonly id: string;
  /** The way it rises. */
  readonly direction: Dir;
  /** Core 17.4: the rooms its foot and head are in, as the engine derives them. */
  readonly footRoom: string;
  readonly headRoom: string;
  readonly risers: number;
  /** Base units, as derived (17.4–17.6). */
  readonly riserHeight: number;
  readonly run: number;
  readonly headroom: number;
  readonly minHeadroom: number;
  /** The engine's landings measure: clear floor before its foot and beyond its head, base units; absent where no wall is met. */
  readonly clearAtFoot?: number;
  readonly clearAtHead?: number;
}

/** How many points below the best a candidate of a new structure may score and still be preferred to a near-duplicate. */
const DIVERSITY = 8;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The level to draw on, and the operations that create it when there is none. */
function chooseTarget(doc: Json, program: Program, options: SolveOptions, used: Set<string>): Target {
  const ids = new Ids(used);
  const levels = collection(doc, 'levels');
  if (options.level !== undefined) {
    if (levels[options.level] === undefined) throw new SolverError(`level ${options.level} is not in the document`);
    if (!levelIsEmpty(doc, options.level)) throw new SolverError(`level ${options.level} already has walls or rooms; the solver lays out an empty level`);
    return { level: options.level, prelude: [] };
  }
  const preferred = new Map<string, number>();
  for (const item of Object.values(program.items ?? {})) if (item.level !== undefined) preferred.set(item.level, (preferred.get(item.level) ?? 0) + 1);
  const ranked = [...preferred].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]));
  for (const [id] of ranked) if (levels[id] !== undefined && levelIsEmpty(doc, id)) return { level: id, prelude: [] };
  for (const id of levelsByElevation(doc)) if (levelIsEmpty(doc, id)) return { level: id, prelude: [] };
  const buildings = Object.keys(collection(doc, 'buildings')).sort(cmp);
  const prelude: Operation[] = [];
  let building = buildings[0];
  const top = levelsByElevation(doc).at(-1);
  if (building === undefined) {
    building = ids.mint('B');
    prelude.push({ op: 'addElement', collection: 'buildings', id: building, element: { name: 'House' } });
  }
  const level = ids.mint('L');
  if (top !== undefined) prelude.push({ op: 'addLevel', id: level, building: String(levels[top]!['building']), above: top, height: 9 * BU_PER_FOOT, name: 'Layout' });
  else prelude.push({ op: 'addLevel', id: level, building, elevation: 0, height: 9 * BU_PER_FOOT, name: 'Ground floor' });
  return { level, prelude };
}

/** Scale a layout's grid coordinates to a footprint; undefined if a room would fall below its least dimension. */
function fitFootprint(layout: Layout, width: number, depth: number, note = 'stretched to the given footprint'): Layout | undefined {
  const sx = (x: number): number => Math.round((x * width) / layout.width);
  const sy = (y: number): number => Math.round((y * depth) / layout.depth);
  const spaces = layout.spaces.map((s) => ({ ...s, rect: { x0: sx(s.rect.x0), y0: sy(s.rect.y0), x1: sx(s.rect.x1), y1: sy(s.rect.y1) } }));
  const out: Layout = { ...layout, width, depth, spaces, notes: layout.notes.includes(note) ? layout.notes : [...layout.notes, note] };
  return sane(out) ? out : undefined;
}

/** Every space at least its least dimension (halls their width, closets 2' 6"); rooms no more than 3.5 : 1. */
function sane(layout: Layout): boolean {
  if (!tiles(layout)) return false;
  for (const s of layout.spaces) {
    const w = s.rect.x1 - s.rect.x0;
    const h = s.rect.y1 - s.rect.y0;
    const least = s.kind === 'closet' ? 5 : s.kind === 'hall' ? 7 : Math.min(minDim(s.fn), 18);
    if (Math.min(w, h) < least) return false;
    if (s.kind === 'room' && Math.max(w, h) / Math.min(w, h) > 3.5) return false;
  }
  return true;
}

/** What the score needs to know of the plan besides the engine's measures. */
function scoreContext(layout: Layout, segs: readonly Seg[], access: Access): ScoreContext {
  const daylit = new Set<string>();
  for (const seg of segs) if (isExterior(seg) && fits(seg, 36 + 12)) daylit.add(insideOf(seg));
  const e = access.entry.seg;
  return { entry: access.entry.space, frontEntry: e !== undefined && e.horizontal && e.a[1] === 0, daylit };
}

/** The score context of a two-level house: the lower level's front door, daylight on both levels. */
function twoContext(lower: Layout, segs: readonly Seg[], access: Access, upperSegs: readonly Seg[]): ScoreContext {
  const ctx = scoreContext(lower, segs, access);
  const daylit = new Set(ctx.daylit);
  for (const seg of upperSegs) if (isExterior(seg) && fits(seg, 36 + 12)) daylit.add(insideOf(seg));
  return { ...ctx, daylit };
}

/** The structure a candidate is varied by: a two-level candidate's also by the room its stair stands in. */
const structureOf = (b: Built): string => (b.upper === undefined ? b.layout.structure : `${b.layout.structure}|${b.layout.spaces.find((x) => x.key === b.upper!.placement.host)?.fn ?? ''}`);

/** The lower level's tiling of a candidate: a two-level candidate's signature is its tiling's and its stair's. */
const tilingOf = (b: Built): string => b.sig.split('#')[0]!;

/** How many of the best lower-level tilings a two-level solve places a stair in and lays an upper level over. */
const TWO_LEVEL_TILINGS = 24;
/** How many placements of the stair in one tiling are estimated in full, and how many are kept. */
const PLACEMENTS_ESTIMATED = 4;
const PLACEMENTS_KEPT = 2;
/** How much a lower tiling is enlarged, in turn, when no upper level fits its outline. */
const GROWTH = [1, 1.08, 1.16] as const;
/** The upper hall's depth, grid units (upper.ts). */
const UPPER_HALL = 8;

/** A two-level plan's upper half: where the stair stands, and the upper level laid out round it. */
interface UpperPlan {
  readonly placement: Placement;
  readonly upper: Upper;
  /** Both levels' rooms under one set of keys, the well left out: what the house is scored as. */
  readonly merged: Layout;
}

interface Built {
  readonly variant: Variant;
  readonly layout: Layout;
  readonly sig: string;
  readonly estimate: ScoreBreakdown;
  readonly upper?: UpperPlan;
}

/**
 * The two levels a two-level layout is for (FLR-T-12.16): the lowest level the brief's items prefer
 * and the level directly above it in its building, when items prefer that one too and both are
 * empty. Undefined otherwise.
 */
function levelPair(doc: Json, program: Program): { lo: string; hi: string } | undefined {
  const preferred = new Set<string>();
  for (const item of Object.values(program.items ?? {})) if (item.level !== undefined) preferred.add(item.level);
  const levels = collection(doc, 'levels');
  const ordered = levelsByElevation(doc);
  for (const lo of ordered) {
    if (!preferred.has(lo) || !levelIsEmpty(doc, lo)) continue;
    const building = levels[lo]!['building'];
    const hi = ordered.slice(ordered.indexOf(lo) + 1).find((id) => levels[id]!['building'] === building);
    if (hi !== undefined && preferred.has(hi) && levelIsEmpty(doc, hi) && Number(levels[hi]!['elevation']) > Number(levels[lo]!['elevation'])) return { lo, hi };
    return undefined;
  }
  return undefined;
}

/** Both levels' spaces as one layout, the well left out — rooms are scored as one house. */
function mergeLevels(lower: Layout, upper: Layout): Layout {
  return { ...lower, spaces: [...lower.spaces, ...upper.spaces.filter((s) => s.kind !== 'well')], notes: [...lower.notes] };
}

/** A stable key of a placement of the stair. */
const placementKey = (p: Placement): string => `${p.host}-${p.dir}-${String(p.xc)}-${String(p.H)}`;

/** A length in feet and inches, to the half inch (no locale: the same text everywhere). */
function ftIn(bu: number): string {
  const halves = Math.round((bu / BU_PER_INCH) * 2);
  const ft = Math.floor(halves / 24);
  const inches = (halves - ft * 24) / 2;
  const i = Number.isInteger(inches) ? String(inches) : `${String(Math.floor(inches))} 1/2`;
  return ft === 0 ? `${i}"` : `${String(ft)}' ${i}"`;
}

/** Square feet, rounded, with thousands separators (no locale: the same text everywhere). */
const sqft = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function explain(layout: Layout, brief: Brief, m: Measures, entry: string, s: ScoreBreakdown, levels = 1): string[] {
  const out = [...layout.notes];
  const byKey = new Map(layout.spaces.map((x) => [x.key, x]));
  const net = [...m.rooms.values()].reduce((t, r) => t + r.area, 0);
  const gross = sqft((levels * layout.width * layout.depth) / 4);
  out.push(
    `footprint ${String(layout.width / 2)}' x ${String(layout.depth / 2)}' (${gross} sq ft gross${levels > 1 ? ` on ${String(levels)} levels` : ''}), ${sqft(net)} sq ft net in ${String(layout.spaces.length)} rooms`,
  );
  out.push(`front door into ${byKey.get(entry)!.name}`);
  const nameOf = (item: string): string => brief.items[item]?.name ?? item;
  for (const a of m.adjacency) {
    const pair = `${nameOf(a.a)} – ${nameOf(a.b)}`;
    if (a.kind === 'forbidden') out.push(`forbidden ${pair}: ${a.adjacent ? 'VIOLATED, they share a wall' : 'kept apart'}`);
    else out.push(`${a.kind} ${pair}: ${a.adjacent ? 'adjacent' : 'NOT adjacent'}`);
  }
  for (const sp of layout.spaces) {
    if (sp.req === undefined) continue;
    const r = m.rooms.get(sp.key);
    if (r === undefined) continue;
    const pct = Math.round((100 * r.area) / sp.req.target);
    if (pct < 92 || pct > 120) out.push(`${sp.name}: ${sqft(r.area)} sq ft against a target of ${sqft(sp.req.target)} (${String(pct)}%)`);
  }
  const d = s.detail;
  out.push(
    d.reach === 1 ? 'every room is reachable from the front door' : `${String(Math.round((1 - d.reach) * layout.spaces.length))} rooms cannot be reached from the front door`,
  );
  if (d.sleepingThroughSleeping > 0) out.push(`${String(d.sleepingThroughSleeping)} bedrooms are reached only through another bedroom`);
  else if (layout.spaces.some((x) => x.fn === 'sleeping')) out.push('no bedroom is reached through another bedroom');
  if (!d.frontEntry) out.push('the front door is not on the front (south) face');
  if (d.daylight < 1) out.push(`${String(Math.round((1 - d.daylight) * 100))}% of habitable rooms have no outside wall for a window`);
  if (layout.spaces.some((x) => x.kind === 'hall')) out.push(`hall is ${String(Math.round(d.hallShare * 100))}% of the net area`);
  const codes = new Map<string, number>();
  for (const f of m.findings) codes.set(f.code, (codes.get(f.code) ?? 0) + 1);
  out.push(
    codes.size === 0
      ? 'engine findings: none'
      : `engine findings: ${[...codes]
          .sort((a, b) => cmp(a[0], b[0]))
          .map(([c, n]) => `${c} x${String(n)}`)
          .join(', ')}`,
  );
  return out;
}

/** A program as its canonical form has it, defaults left out: two spellings of one program compare equal. */
const programOf = (program: unknown): unknown => (omitDefaults({ floorspec: '0.2', project: { name: 'x' }, program }) as Json)['program'];

/** Lay out a program: ranked candidates, each an Ops batch that commits on the document. */
export function solve(document: string | Uint8Array | object, options: SolveOptions = {}): Candidate[] {
  const doc = parseDocument(document);
  const program = options.program ?? (isObject(doc['program']) ? doc['program'] : undefined);
  if (program === undefined || Object.keys(program.items ?? {}).length === 0) throw new SolverError('there is no program to lay out: give the document a program (Core 0.2, chapter 11) or pass one');
  // The program must be valid against this document (references, IDs): check it as Core 0.2 or later.
  // A program the document does not hold is laid out against the document with it — a 0.1 document
  // read as 0.2, a later one at its own version; rooms already linked to the document's own items
  // are left unlinked in that view.
  const own = isObject(doc['program']) && jsonEqual(programOf(doc['program']), programOf(program));
  const withProgram: Json = own ? doc : { ...structuredClone(doc), floorspec: doc['floorspec'] === '0.1' ? '0.2' : doc['floorspec'], program: structuredClone(program) };
  if (!own) {
    const items = new Set(Object.keys(program.items ?? {}));
    for (const room of Object.values(collection(withProgram, 'rooms'))) if (typeof room['brief'] === 'string' && !items.has(room['brief'])) delete room['brief'];
  }
  const pc = check(withProgram);
  if (!pc.valid) {
    const errors = pc.diagnostics.filter((x) => x.severity === 'error');
    throw new SolverError(`the program is not valid for this document: ${errors.map((x) => `${x.code} ${x.message}`).join('; ')}`);
  }
  const retired = [...(options.retired ?? [])].sort(cmp);
  const used = idsOf(withProgram);
  for (const id of retired) used.add(id);
  // Two levels when the brief's items prefer two empty levels, one directly above the other.
  const pair = options.level === undefined && options.ignoreItemLevels !== true ? levelPair(doc, program) : undefined;
  let target: Target = pair === undefined ? chooseTarget(doc, program, options, used) : { level: pair.lo, prelude: [] };
  const fulfilled = new Map<string, number>();
  for (const room of Object.values(collection(doc, 'rooms'))) {
    const b = room['brief'];
    if (typeof b === 'string') fulfilled.set(b, (fulfilled.get(b) ?? 0) + 1);
  }
  let brief = readBrief(program, { level: target.level, ignoreItemLevels: options.ignoreItemLevels ?? false, fulfilled });
  // Candidates are applied to the document as given and measured on what they commit (or, for a
  // program passed in, on the document with it).
  const working = withProgram;
  const emitBrief = own && (options.emitBrief ?? true);

  // The upper level's rooms, the brief as both levels hold it, and how the stair rises (the engine's
  // say, from a probe). Without them — no upper rooms, too many to share out, no stair the engine
  // derives — the lower level is laid out alone, as a single level is.
  let upperReqs: Req[] = [];
  let whole: Brief = brief;
  let planner: UpperPlanner | undefined;
  let profile: Profile | undefined;
  const upgrade: Operation[] = ['0.1', '0.2', '0.3'].includes(String(working['floorspec'])) ? [{ op: 'setProperty', id: '$document', path: '/floorspec', value: '0.4' }] : [];
  if (pair !== undefined && brief.reqs.length > 0) {
    const above = readBrief(program, { level: pair.hi, ignoreItemLevels: false, fulfilled });
    upperReqs = above.reqs.filter((r) => brief.items[r.item]?.level === pair.hi);
    planner = upperReqs.length > 0 ? new UpperPlanner(upperReqs) : undefined;
    if (planner?.feasible === true) profile = profileOf(working, pair.lo, pair.hi, used, upgrade);
    if (profile !== undefined) {
      const up = new Set(upperReqs.map((r) => r.item));
      whole = { ...brief, reqs: [...brief.reqs, ...upperReqs], unplaced: brief.unplaced.filter((u) => !up.has(u.item)) };
    }
  }
  const two = pair !== undefined && planner !== undefined && profile !== undefined ? { pair, planner, profile } : undefined;
  if (pair !== undefined && two === undefined) {
    // Not two levels after all: one level, chosen as it always is.
    target = chooseTarget(doc, program, options, used);
    brief = readBrief(program, { level: target.level, ignoreItemLevels: options.ignoreItemLevels ?? false, fulfilled });
    whole = brief;
  }
  if (brief.reqs.length === 0) throw new SolverError('every item of the program is already fulfilled or belongs on another level: nothing to place');

  // Build and estimate every variant.
  const built: Built[] = [];
  const footprint = options.footprint === undefined ? undefined : { w: Math.floor(options.footprint.width / GRID), d: Math.floor(options.footprint.depth / GRID) };
  for (const v of variants({ reqs: brief.reqs, adjacency: brief.adjacency })) {
    let layout = v.build();
    if (layout === undefined || !sane(layout)) continue;
    if (footprint !== undefined) {
      layout = fitFootprint(layout, footprint.w, footprint.d);
      if (layout === undefined) continue;
    } else if (two !== undefined) {
      // The upper level shares this outline: make it big enough for the upper rooms, their hall and the stair.
      const need = upperReqs.reduce((t, r) => t + grossG(r), 0) + UPPER_HALL * Math.max(layout.width, layout.depth) + UPPER_HALL * Math.ceil((two.profile.run + LANDING_CLEAR) / GRID);
      if (layout.width * layout.depth < need) {
        const k = Math.sqrt(need / (layout.width * layout.depth));
        layout = fitFootprint(layout, Math.ceil(layout.width * k), Math.ceil(layout.depth * k), 'enlarged so the upper floor, on the same outline, holds its rooms');
        if (layout === undefined) continue;
      }
    }
    const segs = segments(layout);
    const access = planAccess(layout, segs);
    if (access === undefined) continue;
    const est = score(layout, brief, estimate(layout, segs, access, brief), scoreContext(layout, segs, access));
    built.push({ variant: v, layout, sig: signature(layout), estimate: est });
  }
  // Best estimate first; equal estimates in a seeded order, then by key.
  const prng = new Prng(options.seed ?? 1);
  const tiebreak = new Map(prng.shuffle(built.map((b) => b.variant.key)).map((k, i) => [k, i]));
  const order0 = (a: Built, b: Built): number => b.estimate.total - a.estimate.total || tiebreak.get(a.variant.key)! - tiebreak.get(b.variant.key)! || cmp(a.sig, b.sig);
  built.sort(order0);
  // Two levels: in the best lower tilings, every place the stair can stand, the upper level laid out
  // round each, and the best few of each tiling estimated as one house.
  let pool = built;
  const fallback: string[] = [];
  if (two !== undefined) {
    const plans: Built[] = [];
    const looked = new Set<string>();
    for (const b0 of built) {
      if (looked.has(b0.sig)) continue;
      looked.add(b0.sig);
      if (looked.size > TWO_LEVEL_TILINGS) break;
      // Every place the stair can stand, and the upper level round each; when none fits, the same
      // tiling a little larger (unless the footprint was given), so the upper rooms have the room.
      let layout = b0.layout;
      let opts: { p: Placement; up: Upper; cost: number }[] = [];
      for (const grow of footprint === undefined ? GROWTH : [1]) {
        const grown = grow === 1 ? b0.layout : fitFootprint(b0.layout, Math.ceil(b0.layout.width * grow), Math.ceil(b0.layout.depth * grow), 'enlarged so the upper floor, on the same outline, holds its rooms');
        if (grown === undefined) continue;
        layout = grown;
        const gsegs = segments(layout);
        const gaccess = planAccess(layout, gsegs);
        if (gaccess === undefined) continue;
        for (const p of placements(layout, gsegs, gaccess, two.profile)) {
          const f2 = frameFor(p, layout.width, layout.depth, two.profile);
          if (f2 === undefined) continue;
          const [up] = two.planner.build(p, f2, layout.family, 1);
          if (up !== undefined) opts.push({ p, up, cost: p.cost * 20 + up.cost });
        }
        if (opts.length > 0) break;
      }
      if (opts.length === 0) continue;
      opts = opts.sort((x, y) => x.cost - y.cost || cmp(placementKey(x.p), placementKey(y.p)));
      const b: Built = layout === b0.layout ? b0 : { ...b0, layout, sig: signature(layout) };
      const segs = segments(b.layout);
      const access = planAccess(b.layout, segs)!;
      const tried = new Set<string>();
      const mine: Built[] = [];
      for (const o of opts) {
        if (tried.size >= PLACEMENTS_ESTIMATED) break;
        const tag = `${o.p.host}|${o.p.dir}`;
        if (tried.has(tag)) continue;
        tried.add(tag);
        const usegs = segments(o.up.layout);
        const uaccess = planAccess(o.up.layout, usegs, { arrival: o.up.arrival });
        if (uaccess === undefined) continue;
        const merged = mergeLevels(b.layout, o.up.layout);
        const m = estimateLevels(
          [
            { layout: b.layout, segs, access },
            { layout: o.up.layout, segs: usegs, access: uaccess },
          ],
          merged,
          whole,
          [[o.p.host, o.up.arrival]],
        );
        const est = score(merged, whole, m, twoContext(b.layout, segs, access, usegs));
        mine.push({ variant: b.variant, layout: b.layout, sig: `${b.sig}#${placementKey(o.p)}`, estimate: est, upper: { placement: o.p, upper: o.up, merged } });
      }
      mine.sort(order0);
      plans.push(...mine.slice(0, PLACEMENTS_KEPT));
    }
    plans.sort(order0);
    if (plans.length > 0) pool = plans;
    else {
      // No stair fits any of them: the lower level alone, its upper rooms unplaced.
      whole = brief;
      fallback.push(`no straight stair and upper level could be fitted to these layouts, so ${two.pair.hi} is not laid out`);
    }
  }
  // The shortlist: the best estimate of each structure first, then of each tiling (a two-level
  // candidate's lower level may carry its stair in more than one place), then the next best; never
  // one plan twice.
  const want = Math.max(options.count ?? 5, 3);
  const evaluateN = Math.max(options.evaluate ?? 10, want);
  const seen = new Set<string>();
  const structures = new Set<string>();
  const shortlist: Built[] = [];
  const tilings = new Set<string>();
  for (const pass of [0, 1, 2])
    for (const b of pool) {
      if (shortlist.length >= evaluateN) break;
      if (seen.has(b.sig) || (pass === 0 && structures.has(structureOf(b))) || (pass === 1 && tilings.has(tilingOf(b)))) continue;
      seen.add(b.sig);
      structures.add(structureOf(b));
      tilings.add(tilingOf(b));
      shortlist.push(b);
    }

  // Apply and measure each in full. Each mints from the same state: the document's IDs, the
  // retired ones, the prelude's.
  const named = (ops: readonly Operation[]): string[] => ops.flatMap((o) => ('id' in o && typeof o.id === 'string' ? [o.id] : []));
  const realise = (b: Built, t: Target, from: ReadonlySet<string>): Omit<Candidate, 'rank'> | undefined =>
    b.upper === undefined || two === undefined ? realiseOne(b, t, from) : realiseTwo(b, b.upper, two.pair, from);
  const realiseOne = (b: Built, t: Target, from: ReadonlySet<string>): Omit<Candidate, 'rank'> | undefined => {
    const layout = b.layout;
    const segs = segments(layout);
    const access = planAccess(layout, segs)!;
    const ids = new Ids(new Set([...from, ...named(t.prelude)]));
    // Measured with every room's brief set, so the engine derives the brief fit from the document.
    const emitted = emit(layout, segs, access, t, ids, { windows: options.windows ?? true, brief: true });
    const applied = measure(working, emitted.batch, retired, layout, emitted.roomIds, brief);
    if (applied.status === 'rejected') return undefined;
    const m = applied.measures;
    const s = score(layout, brief, m, scoreContext(layout, segs, access));
    const rooms: CandidateRoom[] = layout.spaces.map((sp) => ({
      id: emitted.roomIds.get(sp.key)!,
      name: access.names.get(sp.key) ?? sp.name,
      function: sp.fn,
      ...(sp.req === undefined ? {} : { item: sp.req.item }),
      kind: sp.kind,
      rect: [gBu(sp.rect.x0), gBu(sp.rect.y0), gBu(sp.rect.x1), gBu(sp.rect.y1)],
      area: Math.round((m.rooms.get(sp.key)?.area ?? 0) * 10) / 10,
      level: t.level,
    }));
    return {
      id: b.variant.key,
      strategy: layout.family,
      label: layout.label,
      level: t.level,
      levels: [t.level],
      batch: emitBrief ? emitted.batch : emitted.batch.filter((o) => !(o.op === 'setProperty' && o.path === '/brief')),
      footprint: { width: gBu(layout.width), depth: gBu(layout.depth) },
      rooms,
      entry: emitted.roomIds.get(access.entry.space)!,
      unplaced: brief.unplaced,
      score: s,
      explanation: [...explain(layout, brief, m, access.entry.space, s), ...fallback],
    };
  };
  // Both levels in one batch: the upgrade to Core 0.4 when the document is older (a stair's
  // minHeadroom is a 0.4 member), the lower level, the upper level with the types the lower one
  // added, and the stair. Kept only if the engine finds the stair as it was planned.
  const realiseTwo = (b: Built, u: UpperPlan, pair: { lo: string; hi: string }, from: ReadonlySet<string>): Omit<Candidate, 'rank'> | undefined => {
    const { placement: p, upper: up, merged } = u;
    const layout = b.layout;
    const segs = segments(layout);
    const access = planAccess(layout, segs)!;
    const usegs = segments(up.layout);
    const uaccess = planAccess(up.layout, usegs, { arrival: up.arrival })!;
    const ids = new Ids(new Set(from));
    const types = new Map<TypeName, string>();
    const windows = options.windows ?? true;
    const lower = emit(layout, segs, access, { level: pair.lo, prelude: [] }, ids, { windows, brief: true, types });
    const upper = emit(up.layout, usegs, uaccess, { level: pair.hi, prelude: [] }, ids, { windows, brief: true, types });
    const stairId = ids.mint('ST');
    const position = toActual({ dir: p.dir, W: layout.width, D: layout.depth }, p.xc, p.foot, GRID);
    const batch: Operation[] = [...upgrade, ...lower.batch, ...upper.batch, { op: 'addElement', collection: 'stairs', id: stairId, element: stairElement(pair.lo, pair.hi, position, p.dir) }];
    const roomIds = new Map([...lower.roomIds, ...upper.roomIds]);
    const applied = measure(working, batch, retired, merged, roomIds, whole);
    if (applied.status === 'rejected') return undefined;
    // The stair as the engine derives it: between the rooms it was placed between, with its headroom
    // (17.6) and 3' of floor at its foot and head (the engine's landings measure).
    const d = applied.derived.stairs?.[stairId];
    const footRoom = roomIds.get(p.host)!;
    const headRoom = roomIds.get(up.arrival)!;
    if (d === undefined || d.footRoom !== footRoom || d.headRoom !== headRoom || d.headroom === undefined || d.headroom < STAIR.minHeadroom) return undefined;
    if (applied.diagnostics.some((x) => x.code === 'FS-LINT-019')) return undefined;
    const land = landings(applied.document).find((l) => l.stair === stairId);
    if (land === undefined || (land.foot ?? Infinity) < LANDING_CLEAR || (land.head ?? Infinity) < LANDING_CLEAR) return undefined;
    // The stair joins its foot room and its head room in the door graph (Core 14.1, 17.8).
    const m: Measures = { ...applied.measures, connected: new Set([...applied.measures.connected, pairKey(p.host, up.arrival)]) };
    const s = score(merged, whole, m, twoContext(layout, segs, access, usegs));
    const upperKeys = new Set(up.layout.spaces.map((x) => x.key));
    const rooms: CandidateRoom[] = merged.spaces.map((sp) => ({
      id: roomIds.get(sp.key)!,
      name: (upperKeys.has(sp.key) ? uaccess : access).names.get(sp.key) ?? sp.name,
      function: sp.fn,
      ...(sp.req === undefined ? {} : { item: sp.req.item }),
      kind: sp.kind,
      rect: [gBu(sp.rect.x0), gBu(sp.rect.y0), gBu(sp.rect.x1), gBu(sp.rect.y1)],
      area: Math.round((m.rooms.get(sp.key)?.area ?? 0) * 10) / 10,
      level: upperKeys.has(sp.key) ? pair.hi : pair.lo,
    }));
    const host = layout.spaces.find((x) => x.key === p.host)!;
    const hostName = access.names.get(host.key) ?? host.name;
    const stair: CandidateStair = {
      id: stairId,
      direction: p.dir,
      footRoom,
      headRoom,
      risers: d.risers,
      riserHeight: d.riserHeight,
      run: d.run ?? (d.risers - 1) * STAIR.tread,
      headroom: d.headroom,
      minHeadroom: STAIR.minHeadroom,
      ...(land.foot === undefined ? {} : { clearAtFoot: land.foot }),
      ...(land.head === undefined ? {} : { clearAtHead: land.head }),
    };
    const lines = explain(merged, whole, m, access.entry.space, s, 2);
    const levelName = (id: string): string => {
      const n = collection(doc, 'levels')[id]?.['name'];
      return typeof n === 'string' ? `${n} (${id})` : id;
    };
    lines.splice(
      layout.notes.length + 1,
      0,
      `two levels on one ${String(layout.width / 2)}' x ${String(layout.depth / 2)}' outline: ${levelName(pair.lo)} below, ${levelName(pair.hi)} above`,
      `${describePlacement(p, { ...host, name: hostName })} to the Upper hall: ${String(d.risers)} risers of ${ftIn(d.riserHeight)}, ${ftIn(STAIR.tread)} treads, ${ftIn(STAIR.width)} wide`,
      `stair headroom ${ftIn(d.headroom)} (designed for ${ftIn(STAIR.minHeadroom)}); ${land.foot === undefined ? 'open floor' : ftIn(land.foot)} clear at its foot, ${land.head === undefined ? 'open floor' : ftIn(land.head)} at its head`,
      ...up.notes.map((n) => `upstairs ${n}`),
    );
    return {
      id: `${b.variant.key}+${placementKey(p)}`,
      strategy: layout.family,
      label: `${layout.label}; upstairs over it, a stair rising ${dirName(p.dir)} from the ${hostName}`,
      level: pair.lo,
      levels: [pair.lo, pair.hi],
      stair,
      batch: emitBrief ? batch : batch.filter((o) => !(o.op === 'setProperty' && o.path === '/brief')),
      footprint: { width: gBu(layout.width), depth: gBu(layout.depth) },
      rooms,
      entry: roomIds.get(access.entry.space)!,
      unplaced: whole.unplaced,
      score: s,
      explanation: lines,
    };
  };
  const scored: { b: Built; candidate: Omit<Candidate, 'rank'> }[] = [];
  for (const b of shortlist) {
    const candidate = realise(b, target, used);
    if (candidate !== undefined) scored.push({ b, candidate });
  }
  if (scored.length === 0)
    throw new SolverError(
      built.length === 0
        ? 'no strategy could lay out this program: every room needs a door, and a house needs a living space, an entry or a room that is not a bedroom to enter by'
        : 'no candidate layout committed and checked without errors',
    );
  const order = (p: (typeof scored)[number], q: (typeof scored)[number]): number =>
    q.candidate.score.total - p.candidate.score.total || q.candidate.score.briefFit - p.candidate.score.briefFit || cmp(p.candidate.id, q.candidate.id);
  scored.sort(order);
  // A varied set: after the best, prefer a candidate of a structure not yet chosen while it scores
  // within DIVERSITY points of the best one left; then rank what was chosen by score.
  const chosen: typeof scored = [];
  const left = [...scored];
  while (chosen.length < want && left.length > 0) {
    const top = left[0]!.candidate.score.total;
    const have = new Set(chosen.map((c) => structureOf(c.b)));
    const tiled = new Set(chosen.map((c) => tilingOf(c.b)));
    let i = left.findIndex((c) => !have.has(structureOf(c.b)) && c.candidate.score.total >= top - DIVERSITY);
    if (i < 0) i = left.findIndex((c) => !tiled.has(tilingOf(c.b)) && c.candidate.score.total >= top - DIVERSITY);
    if (i < 0) i = 0;
    chosen.push(left.splice(i, 1)[0]!);
  }
  chosen.sort(order);
  if (options.distinctIds === true) {
    // In rank order, each candidate after the first is written again minting after the ones before
    // it — the same layout, measured the same, under IDs no other candidate names.
    const taken = new Set(used);
    for (const [i, x] of chosen.entries()) {
      if (i > 0) {
        const again = realise(x.b, chooseTarget(doc, program, options, taken), taken);
        if (again === undefined) throw new SolverError(`candidate ${x.candidate.id} did not commit under distinct IDs`);
        x.candidate = again;
      }
      for (const id of named(x.candidate.batch)) taken.add(id);
    }
  }
  return chosen.map((x, i) => ({ ...x.candidate, rank: i + 1 }));
}
