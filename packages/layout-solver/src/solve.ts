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
 * Deterministic: no clock, no Math.random; every enumeration and every tie is broken by a stable
 * key. The same document and options give the same candidates, byte for byte.
 */
import { check, jsonEqual, omitDefaults } from '@floorspec/engine';
import type { Operation } from '@floorspec/ops';
import { fits, planAccess, type Access } from './access.js';
import { variants, type Variant } from './builders.js';
import { collection, idsOf, levelIsEmpty, levelsByElevation, parseDocument, SolverError, type Json } from './document.js';
import { emit, Ids, type Target } from './emit.js';
import { insideOf, isExterior, segments, signature, tiles, type Family, type Layout, type Seg, type Space } from './layout.js';
import { estimate, measure, type Measures } from './measure.js';
import { minDim, readBrief, type Brief, type Program, type Unplaced } from './program.js';
import { Prng } from './random.js';
import { score, type ScoreBreakdown, type ScoreContext } from './score.js';
import { BU_PER_FOOT, gBu, GRID } from './units.js';

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
  readonly level: string;
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
function fitFootprint(layout: Layout, width: number, depth: number): Layout | undefined {
  const sx = (x: number): number => Math.round((x * width) / layout.width);
  const sy = (y: number): number => Math.round((y * depth) / layout.depth);
  const spaces = layout.spaces.map((s) => ({ ...s, rect: { x0: sx(s.rect.x0), y0: sy(s.rect.y0), x1: sx(s.rect.x1), y1: sy(s.rect.y1) } }));
  const out: Layout = { ...layout, width, depth, spaces, notes: [...layout.notes, 'stretched to the given footprint'] };
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
  return { entry: access.entry.space, frontEntry: e.horizontal && e.a[1] === 0, daylit };
}

interface Built {
  readonly variant: Variant;
  readonly layout: Layout;
  readonly sig: string;
  readonly estimate: ScoreBreakdown;
}

/** Square feet, rounded, with thousands separators (no locale: the same text everywhere). */
const sqft = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function explain(layout: Layout, brief: Brief, m: Measures, entry: string, s: ScoreBreakdown): string[] {
  const out = [...layout.notes];
  const byKey = new Map(layout.spaces.map((x) => [x.key, x]));
  const net = [...m.rooms.values()].reduce((t, r) => t + r.area, 0);
  out.push(
    `footprint ${String(layout.width / 2)}' x ${String(layout.depth / 2)}' (${sqft((layout.width * layout.depth) / 4)} sq ft gross), ${sqft(net)} sq ft net in ${String(layout.spaces.length)} rooms`,
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
  // The program must be valid against this document (references, IDs): check it as Core 0.2.
  // A program the document does not hold is laid out against the document with it, as Core 0.2;
  // rooms already linked to the document's own items are left unlinked in that view.
  const own = isObject(doc['program']) && jsonEqual(programOf(doc['program']), programOf(program));
  const withProgram: Json = own ? doc : { ...structuredClone(doc), floorspec: '0.2', program: structuredClone(program) };
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
  const target = chooseTarget(doc, program, options, used);
  const fulfilled = new Map<string, number>();
  for (const room of Object.values(collection(doc, 'rooms'))) {
    const b = room['brief'];
    if (typeof b === 'string') fulfilled.set(b, (fulfilled.get(b) ?? 0) + 1);
  }
  const brief = readBrief(program, { level: target.level, ignoreItemLevels: options.ignoreItemLevels ?? false, fulfilled });
  if (brief.reqs.length === 0) throw new SolverError('every item of the program is already fulfilled or belongs on another level: nothing to place');
  // Candidates are applied to the document as given and measured on what they commit (or, for a
  // program passed in, on the document with it).
  const working = withProgram;
  const emitBrief = own && (options.emitBrief ?? true);

  // Build and estimate every variant.
  const built: Built[] = [];
  const footprint = options.footprint === undefined ? undefined : { w: Math.floor(options.footprint.width / GRID), d: Math.floor(options.footprint.depth / GRID) };
  for (const v of variants({ reqs: brief.reqs, adjacency: brief.adjacency })) {
    let layout = v.build();
    if (layout === undefined || !sane(layout)) continue;
    if (footprint !== undefined) {
      layout = fitFootprint(layout, footprint.w, footprint.d);
      if (layout === undefined) continue;
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
  built.sort((a, b) => b.estimate.total - a.estimate.total || tiebreak.get(a.variant.key)! - tiebreak.get(b.variant.key)!);
  // The shortlist: the best estimate of each structure first, then the next best; never one tiling twice.
  const want = Math.max(options.count ?? 5, 3);
  const evaluateN = Math.max(options.evaluate ?? 10, want);
  const seen = new Set<string>();
  const structures = new Set<string>();
  const shortlist: Built[] = [];
  for (const pass of [0, 1])
    for (const b of built) {
      if (shortlist.length >= evaluateN) break;
      if (seen.has(b.sig) || (pass === 0 && structures.has(b.layout.structure))) continue;
      seen.add(b.sig);
      structures.add(b.layout.structure);
      shortlist.push(b);
    }

  // Apply and measure each in full.
  const scored: { b: Built; candidate: Omit<Candidate, 'rank'> }[] = [];
  for (const b of shortlist) {
    const layout = b.layout;
    const segs = segments(layout);
    const access = planAccess(layout, segs)!;
    // Each candidate mints from the same state: the document's IDs, the retired ones, the prelude's.
    const ids = new Ids(new Set([...used, ...target.prelude.flatMap((o) => ('id' in o && typeof o.id === 'string' ? [o.id] : []))]));
    // Measured with every room's brief set, so the engine derives the brief fit from the document.
    const emitted = emit(layout, segs, access, target, ids, { windows: options.windows ?? true, brief: true });
    const applied = measure(working, emitted.batch, retired, layout, emitted.roomIds, brief);
    if (applied.status === 'rejected') continue;
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
    }));
    scored.push({
      b,
      candidate: {
        id: b.variant.key,
        strategy: layout.family,
        label: layout.label,
        level: target.level,
        batch: emitBrief ? emitted.batch : emitted.batch.filter((o) => !(o.op === 'setProperty' && o.path === '/brief')),
        footprint: { width: gBu(layout.width), depth: gBu(layout.depth) },
        rooms,
        entry: emitted.roomIds.get(access.entry.space)!,
        unplaced: brief.unplaced,
        score: s,
        explanation: explain(layout, brief, m, access.entry.space, s),
      },
    });
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
    const have = new Set(chosen.map((c) => c.b.layout.structure));
    let i = left.findIndex((c) => !have.has(c.b.layout.structure) && c.candidate.score.total >= top - DIVERSITY);
    if (i < 0) i = 0;
    chosen.push(left.splice(i, 1)[0]!);
  }
  chosen.sort(order);
  return chosen.map((x, i) => ({ ...x.candidate, rank: i + 1 }));
}
