/**
 * The staging assistant (FLR-T-13.11): dress a plan's rooms — or a level's, or the rooms asked for —
 * with the FS_furniture starter library's decor, placed by geometric rules around the furniture
 * already there, as one Floorspec Ops batch for a person to review as a changeset (FLR-ADR-016).
 *
 * The rules, in the order they run (each item kept out of everything placed before it):
 *
 *   1. Windows: curtains hung high and wide where the floor before the window is clear, the stacks
 *      kept off doors and corners; a roman blind where it is not, and in kitchens, baths and laundries.
 *   2. Rugs: under a seating group (the sofa's front legs and every chair's on it, the coffee table
 *      wholly), under the lower two thirds of a bed (reaching past its sides), under a dining table
 *      (wide enough for its chairs pulled out), a runner down a hall — never in a door's swing.
 *   3. Media: a console and a television against the wall a sofa faces, when that wall is clear.
 *   4. Art: centred over a sofa or a bed whose back is to a wall, over a dresser or sideboard, a mirror
 *      over each vanity, a picture on an entry's longest blank wall — never over a window, a door, a
 *      switch or an outlet, and below the ceiling.
 *   5. Lamps: a table lamp on each nightstand and on a desk, a floor lamp beside a sofa — each within
 *      a cord's reach of a receptacle when the plan has FS_electrical (preferring the nearest).
 *   6. Textiles: cushions on sofas and beds, a throw over a sofa's arm, a throw across a bed's foot.
 *   7. Tabletops and counters: books and a small plant on a coffee table, a centrepiece on a dining
 *      table, a fruit bowl on an island, a kettle, a cutting board and canisters along the counters,
 *      a soap set on each vanity, clear of sinks and cooktops.
 *   8. Baths: a towel bar on a free wall near the tub or the vanity, a bath mat before them.
 *   9. Plants in corners: an indoor tree or a floor plant in a room's free corners, farthest from its
 *      doors and nearest its windows first.
 *
 * Every standing item is kept out of the room's entry zones, every clearance envelope (a door's
 * swing, a sofa's front, a bed's sides), and every piece it is not grouped with, so paths through a
 * room stay open; what goes on or against a piece is grouped with it (FS_furniture 4.3), so it moves
 * with it and is not reported in its way. Non-normative, advisory and deterministic: the same plan
 * gives the same batch, byte for byte.
 */
import { direction, furniture, type FloorspecDocument } from '@floorspec/engine';
import type { Operation } from '@floorspec/ops';
import { migrationBatch } from '@floorspec/migrate';
import { PlanError } from '@floorspec/assistant-electrical';
import { centroid, crosses, dist, frameAt, grow, inRing, interferes, MM, polysOverlap, rectIn, roundP, toLocal, toPlan, within, type Frame, type P, type Solid } from './geometry.js';
import { alongFace, entryZones, faceFrame, onFace, pieceRect, readStaging, type Hole, type Obstacle, type Piece, type Reading, type Run, type StagingRoom } from './room.js';

type Json = Record<string, unknown>;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const ITEMS = furniture.STARTER_LIBRARY_ITEMS;

export interface StagingOptions {
  /** Only the rooms on this level. */
  level?: string;
  /** Only these rooms (IDs). */
  rooms?: readonly string[];
  /** IDs once used in the plan's history, never minted again (Ops 1.5). */
  retired?: readonly string[];
}

/** One item the proposal places. */
export interface StagedItem {
  id: string;
  /** The library item: `rug-3000x2000`. */
  item: string;
  room: string;
  /** What it was placed for, in a few words: "under the seating group". */
  rule: string;
  /** The piece it is grouped with, when it is. */
  with?: string;
}

export interface StagingProposal {
  /** The batch, ready for a changeset; empty when there is nothing to stage. */
  batch: Operation[];
  /** A name for the changeset. */
  name: string;
  /** What it stages and why, in sentences a person reads before accepting. */
  explanation: string[];
  added: StagedItem[];
  /** The rooms considered, by ID. */
  rooms: string[];
  /** What was left out, and why: a lamp with no receptacle in reach, a wall too full for art. */
  notes: string[];
  /** The library files the batch's assets name — what the server copies into the project's store. */
  files: furniture.StarterLibraryFile[];
}

/** Rooms staging leaves alone: no one stages a garage. */
const SKIP = new Set(['exterior', 'garage', 'storage', 'mechanical', 'utility', 'laundry']);
/** Rooms whose windows get a blind, not curtains. */
const BLINDS = new Set(['bath', 'kitchen', 'laundry']);
/** A cord's reach: a lamp within this of a receptacle (FS_electrical) is plugged in. */
const REACH = 1800 * MM;
/** How far a floor item stands off a wall it is set against. */
const OFF_WALL = 30 * MM;
/** How far a corner plant stands off each wall: snug, or clear of a curtain's 140 mm stack. */
const CORNER_OFFSETS: readonly (readonly [number, number])[] = [[50, 50], [190, 50], [50, 190], [190, 190]].map(([a, b]) => [a! * MM, b! * MM] as const);
/** A square metre, in base units squared. */
const M2 = (1000 * MM) ** 2;
/** How far a rug may slide off its group's centre line to clear a neighbour: centred first. */
const SHIFTS = [0, 150, -150, 300, -300, 450, -450].map((d) => d * MM);

const inRoom = (room: StagingRoom, p: P): boolean => inRing(p, room.outer) && !room.holes.some((h) => inRing(p, h));

const NONE: ReadonlySet<Obstacle['what']> = new Set();
/** What a curtain may hang over: outlets and switches on the wall behind it. */
const DEVICES: ReadonlySet<'device'> = new Set(['device']);

const list = (xs: readonly string[]): string => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1] ?? ''}`);

/** A library item's size: depth (x), width (y), height (z), base units. */
function sizeOf(item: string): { X: number; Y: number; Z: number } {
  const b = ITEMS[item]!.element.fallback.box;
  return { X: b.max[0]! - b.min[0]!, Y: b.max[1]! - b.min[1]!, Z: b.max[2]! - b.min[2]! };
}

/** A box of FS_furniture 3.1's convention, `w` wide, `d` deep and `h` tall, its bottom at `z`. */
function boxOf(d: number, w: number, h: number, z = 0): { min: number[]; max: number[] } {
  const W = Math.round(w);
  const half = Math.floor(W / 2);
  return { min: [0, -half, Math.round(z)], max: [Math.round(d), W - half, Math.round(z) + Math.round(h)] };
}

/** The mesher's sofa (packages/mesh furniture.ts `upholstered`): where its seat, arms and back cushions are, for a box. */
function sofaParts(X: number, Y: number, Z: number) {
  const legH = Math.min(100 * MM, Z * 0.12);
  const arm = Math.min(180 * MM, Y * 0.14);
  const seatTop = Math.max(legH + Z * 0.2, Math.min(Z * 0.52, 450 * MM));
  const armTop = Math.min(Z * 0.75, seatTop + 200 * MM);
  const back = Math.min(220 * MM, X * 0.25) + Math.min(150 * MM, X * 0.18);
  return { arm, seatTop, armTop, back };
}

/** The mesher's bed (`bed`): its mattress and duvet tops, and its pillows' reach from the head. */
function bedParts(X: number, Z: number) {
  const hb = Math.min(60 * MM, X * 0.04);
  const mattress = Z * 0.56;
  return { hb, mattress, duvet: mattress + Math.min(40 * MM, Z * 0.04), pillows: hb + Math.min(40 * MM, X * 0.02) + Math.min(380 * MM, X * 0.19) };
}

/** Propose staging: one batch, with what it adds and why. */
export function proposeStaging(document: string | Uint8Array | FloorspecDocument | object, options: StagingOptions = {}): StagingProposal {
  let reading: Reading;
  try {
    reading = readStaging(document);
  } catch (error) {
    if (error instanceof PlanError) throw new PlanError(error.message.replace('fix it before laying out its electrical', 'fix it before staging it'));
    throw error;
  }
  const doc = reading.document;
  if (options.level !== undefined && !Object.hasOwn(doc.levels ?? {}, options.level)) throw new PlanError(`there is no level ${options.level}`);
  for (const r of options.rooms ?? []) if (!Object.hasOwn(doc.rooms ?? {}, r)) throw new PlanError(`there is no room ${r}`);
  return new Stager(reading, options).run();
}

class Stager {
  private readonly doc: FloorspecDocument;
  private readonly taken: Set<string>;
  private readonly placements: Operation[] = [];
  private readonly assets = new Map<string, string>();
  private readonly assetOps: Operation[] = [];
  private readonly files = new Map<string, furniture.StarterLibraryFile>();
  readonly added: StagedItem[] = [];
  readonly notes: string[] = [];
  private readonly said = new Map<string, string[]>();
  /** What each level's new items keep out of: the plan's, then each item placed. */
  private readonly obstacles: Map<string, Obstacle[]>;

  constructor(
    private readonly r: Reading,
    private readonly options: StagingOptions,
  ) {
    this.doc = r.document;
    this.chosen = r.rooms.filter((rm) => (options.level === undefined || rm.level === options.level) && (options.rooms === undefined || options.rooms.includes(rm.id)));
    this.taken = new Set([...usedIds(this.doc), ...(options.retired ?? [])]);
    this.obstacles = new Map([...r.obstacles.entries()].map(([k, v]) => [k, [...v]]));
    for (const [id, a] of Object.entries((this.doc.assets ?? {}) as Record<string, Json | undefined>).sort(([a], [b]) => cmp(a, b)))
      if (typeof a?.['sha256'] === 'string' && !this.assets.has(a['sha256'])) this.assets.set(a['sha256'], id);
  }

  /** The rooms asked for. */
  private readonly chosen: StagingRoom[];

  run(): StagingProposal {
    for (const room of this.chosen) {
      if (SKIP.has(room.function)) continue;
      this.stage(room);
    }
    const batch: Operation[] = [];
    if (this.placements.length > 0) {
      const used = (this.doc.extensionsUsed ?? {}) as Record<string, unknown>;
      // An element's assets need Core 0.3 (`byteLength`, Core 18.4): a 0.1 or 0.2 plan becomes 0.3 first (Core chapter 20).
      if (this.doc.floorspec === '0.1' || this.doc.floorspec === '0.2') batch.push(...migrationBatch(this.doc, '0.3'));
      if (!Object.hasOwn(used, 'FS_furniture')) batch.push({ op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_furniture', value: '0.1.0' });
      batch.push(...this.assetOps, ...this.placements);
    }
    const rooms = this.chosen;
    const staged = rooms.filter((rm) => this.said.has(rm.id));
    const explanation = [
      this.added.length === 0
        ? `Nothing to stage in ${list(rooms.map((rm) => rm.name)) || 'these rooms'}: no room has furniture to dress or a wall, window or corner free for decor.`
        : `Stages ${list(staged.map((rm) => rm.name))} with ${String(this.added.length)} pieces of decor from the FS_furniture starter library (CC0).`,
      ...staged.map((rm) => `${rm.name}: ${list(this.said.get(rm.id)!)}.`),
      'By rule, around the furniture already there: rugs under seating groups, beds and dining tables, never in a door\'s swing; art centred over a sofa, bed or dresser backed by a wall, never over a window, door, switch or outlet; table lamps on nightstands and desks and a floor lamp beside a sofa, each within reach of a receptacle when the plan has them; plants in free corners away from doors; curtains high and wide where the floor before a window is clear, else a blind. Every standing item is kept out of entry zones and clearance envelopes, and what sits on a piece is grouped with it.',
      ...this.notes,
    ];
    const names = staged.map((rm) => rm.name);
    const name = `Staging: ${list(names)}`.length <= 120 ? `Staging: ${list(names)}` : `Staging: ${String(names.length)} rooms`;
    return { batch, name, explanation, added: this.added, rooms: rooms.map((rm) => rm.id), notes: this.notes, files: [...this.files.values()] };
  }

  // ─── Placing ─────────────────────────────────────────────────────────────────────────────

  private mint(room: string, tag: string): string {
    for (let n = 1; ; n++) {
      const id = `${room}-${tag}${String(n)}`.slice(0, 64);
      if (!this.taken.has(id)) {
        this.taken.add(id);
        return id;
      }
    }
  }

  /** The asset of a library file: the plan's own with its digest, else a new one under the item's name. */
  private assetFor(item: string, role: 'model' | 'symbol'): string {
    const file = ITEMS[item]![role];
    this.files.set(file.sha256, file);
    const have = this.assets.get(file.sha256);
    if (have !== undefined) return have;
    let id = `${role === 'model' ? 'M' : 'S'}-${item}`;
    for (let n = 2; this.taken.has(id); n++) id = `${role === 'model' ? 'M' : 'S'}-${item}-${String(n)}`;
    this.taken.add(id);
    this.assets.set(file.sha256, id);
    const ext = file.mediaType === 'model/gltf-binary' ? 'glb' : file.mediaType === 'image/svg+xml' ? 'svg' : 'bin';
    this.assetOps.push({ op: 'addElement', collection: 'assets', id, element: { path: `assets/${file.sha256}.${ext}`, sha256: file.sha256, mediaType: file.mediaType, byteLength: file.byteLength, name: file.path.split('/').at(-1) ?? file.path } });
    return id;
  }

  /** The solid an item would occupy: its box on the plan, from the floor's z. */
  private solidAt(fr: Frame, box: { min: number[]; max: number[] }, base: number): Solid {
    return { poly: rectIn(fr, box.min[0]!, box.min[1]!, box.max[0]!, box.max[1]!), bottom: base + box.min[2]!, top: base + box.max[2]! };
  }

  /** What an item of `group` would run into: the first obstacle on the level it may not overlap (of those not ignored). */
  private blocked(level: string, s: Solid, group: string | null, extra: readonly Obstacle[] = [], ignore: ReadonlySet<Obstacle['what']> = NONE): Obstacle | undefined {
    for (const o of [...(this.obstacles.get(level) ?? []), ...extra]) {
      if ((group !== null && o.group === group) || ignore.has(o.what)) continue;
      if (interferes(s, o)) return o;
    }
    return undefined;
  }

  /** How many pieces of decor of a family the room already holds — before this run, and in it. */
  private holds(room: StagingRoom, prefix: string, withId?: string): number {
    const before = room.pieces.filter((p) => p.decor?.startsWith(prefix) === true && (withId === undefined || p.root === withId)).length;
    const now = this.added.filter((a) => a.room === room.id && a.item.startsWith(prefix) && (withId === undefined || a.with === withId)).length;
    return before + now;
  }

  private say(room: StagingRoom, what: string): void {
    this.said.set(room.id, [...(this.said.get(room.id) ?? []), what]);
  }

  /** Place a floor item: a surface host on the room's floor, its frame `fr`, its box `box` (raised for one set on a piece). */
  private placeFloor(room: StagingRoom, tag: string, item: string, fr: Frame, box: { min: number[]; max: number[] }, rule: string, withId?: string): string {
    const id = this.mint(room.id, tag);
    const lib = ITEMS[item]!;
    const element: Json = {
      category: lib.element.category,
      catalogue: item,
      name: lib.element.name,
      fallback: { box, asset: this.assetFor(item, 'model'), symbol: this.assetFor(item, 'symbol') },
      ...(withId === undefined ? {} : { with: withId }),
    };
    const at = roundP(fr.origin);
    this.placements.push({
      op: 'placeElement',
      extension: 'FS_furniture',
      collection: lib.kind,
      id,
      host: { mode: 'surface', room: room.id, surface: 'floor', at, ...(fr.facing === 0 ? {} : { rotation: fr.facing }) },
      element,
    } as unknown as Operation);
    const solid = this.solidAt(frameAt(at, fr.facing), box, room.floor);
    this.obstacles.set(room.level, [...(this.obstacles.get(room.level) ?? []), { ...solid, owner: id, group: withId ?? id, what: 'decor' }]);
    this.added.push({ id, item, room: room.id, rule, ...(withId === undefined ? {} : { with: withId }) });
    return id;
  }

  /** Place a wall item: a wall-face host on a run's face at `at`, its bottom `height` above the floor. */
  private placeWall(room: StagingRoom, run: Run, tag: string, item: string, at: number, height: number, box: { min: number[]; max: number[] }, rule: string, withId?: string): string {
    const id = this.mint(room.id, tag);
    const lib = ITEMS[item]!;
    const element: Json = {
      category: lib.element.category,
      catalogue: item,
      name: lib.element.name,
      fallback: { box, asset: this.assetFor(item, 'model'), symbol: this.assetFor(item, 'symbol') },
      ...(withId === undefined ? {} : { with: withId }),
    };
    const offset = Math.round(at);
    this.placements.push({
      op: 'placeElement',
      extension: 'FS_furniture',
      collection: lib.kind,
      id,
      host: { mode: 'wallFace', wall: run.face.wall, side: run.face.side, at: offset, height: Math.round(height) },
      element,
    } as unknown as Operation);
    const solid = this.solidAt(faceFrame(run.face, offset), box, room.floor + Math.round(height));
    this.obstacles.set(room.level, [...(this.obstacles.get(room.level) ?? []), { ...solid, owner: id, group: withId ?? id, what: 'decor' }]);
    this.added.push({ id, item, room: room.id, rule, ...(withId === undefined ? {} : { with: withId }) });
    return id;
  }

  /**
   * Whether an outline is on the room's floor: within it — or, in an open plan, within it and the
   * rooms open to it, crossing none of their walls (a dining rug reaching across into the kitchen).
   */
  private onFloor(room: StagingRoom, poly: readonly P[]): boolean {
    if (within(poly, room.outer, room.holes)) return true;
    const area = [room, ...room.open.map((id) => this.r.rooms.find((o) => o.id === id)!)];
    if (area.length === 1) return false;
    const n = poly.length;
    const samples = [...poly, ...poly.map((p, i) => [(p[0] + poly[(i + 1) % n]![0]) / 2, (p[1] + poly[(i + 1) % n]![1]) / 2] as P), centroid(poly)];
    if (!samples.every((q) => area.some((a) => inRoom(a, q)))) return false;
    const walls = area.flatMap((a) => a.runs.map((r): [P, P] => [onFace(r.face, r.from), onFace(r.face, r.to)]));
    return !walls.some(([a, b]) => poly.some((p, i) => crosses(p, poly[(i + 1) % n]!, a, b)));
  }

  /** Whether a floor-standing item at `fr` fits: in the room, clear of everything but its group, and of the room's entry zones. */
  private fitsFloor(room: StagingRoom, fr: Frame, box: { min: number[]; max: number[] }, group: string | null, opts: { entries?: boolean; margin?: number } = {}): boolean {
    const s = this.solidAt(fr, box, room.floor);
    const poly = opts.margin === undefined ? s.poly : grow(s.poly, opts.margin);
    if (!this.onFloor(room, poly)) return false;
    return this.blocked(room.level, s, group, opts.entries === false ? [] : entryZones(room)) === undefined;
  }

  /** The nearest receptacle to a point, and how far it is; null when the plan has none in the room. */
  private nearestReceptacle(room: StagingRoom, p: P): number | null {
    if (room.receptacles.length === 0) return null;
    return Math.min(...room.receptacles.map((q) => dist(p, q)));
  }

  /** Whether a lamp at p can be plugged in: always without FS_electrical, else with a receptacle in reach. */
  private powered(room: StagingRoom, p: P): boolean {
    if (!this.r.electrical) return true;
    const d = this.nearestReceptacle(room, p);
    return d !== null && d <= REACH;
  }

  // ─── A room ──────────────────────────────────────────────────────────────────────────────

  private stage(room: StagingRoom): void {
    const fn = room.function;
    const pieces = room.pieces;
    const by = (...cats: string[]) => pieces.filter((p) => cats.includes(p.category));
    this.windows(room);
    if (fn === 'circulation') {
      this.runner(room);
      this.blankWallArt(room);
      this.corners(room, room.area >= 5 * M2 ? 1 : 0);
      return;
    }
    if (fn === 'bath') {
      for (const v of by('vanity')) this.vanityMirror(room, v);
      for (const v of by('vanity')) this.vanityTop(room, v);
      this.towelBar(room);
      this.bathMat(room);
      return;
    }
    if (fn === 'kitchen') {
      for (const i of by('island')) this.islandBowl(room, i);
      this.counters(room);
      return;
    }
    const sofas = by('sofa');
    for (const s of sofas) this.seatingRug(room, s);
    for (const b of by('bed')) this.bedRug(room, b);
    for (const t of by('diningTable')) this.diningRug(room, t);
    for (const s of sofas.slice(0, 1)) this.media(room, s);
    let art = 0;
    for (const s of sofas) art += this.artOver(room, s, 'over the sofa') ? 1 : 0;
    for (const b of by('bed')) art += this.artOver(room, b, 'over the bed') ? 1 : 0;
    if (art < 2) for (const d of by('dresser', 'sideboard')) if (this.artOver(room, d, `over the ${d.category}`)) {
      art++;
      break;
    }
    // A room with no art yet, and a blank wall to hang it on.
    if (art === 0 && room.pieces.some((p) => p.decor === undefined)) this.blankWallArt(room);
    for (const n of by('nightstand')) this.nightstandLamp(room, n);
    for (const s of sofas.slice(0, 1)) this.floorLamp(room, s);
    for (const d of by('desk')) this.desk(room, d);
    for (const s of sofas) this.sofaTextiles(room, s, s === sofas[0]);
    for (const b of by('bed')) this.bedTextiles(room, b);
    for (const c of by('coffeeTable')) this.coffeeTable(room, c);
    for (const t of by('diningTable')) this.centrepiece(room, t);
    const big = room.area >= 20 * M2;
    this.corners(room, fn === 'living' || fn === 'family' ? (big ? 2 : 1) : 1);
  }

  // ─── 1. Windows ──────────────────────────────────────────────────────────────────────────

  private windows(room: StagingRoom): void {
    const ceiling = room.ceiling - room.floor;
    // Windows on the room's faces: low enough to dress, wide enough to bother; side by side, one treatment.
    const groups: { run: Run; holes: Hole[] }[] = [];
    for (const h of room.holesInWalls) {
      if (h.kind !== 'window' || h.to - h.from < 450 * MM || h.sill >= 1500 * MM || h.head <= h.sill) continue;
      const run = room.runs.find((r) => r.face.wall === h.wall && h.from >= r.from - 1 && h.to <= r.to + 1);
      if (run === undefined) continue;
      const last = groups[groups.length - 1];
      if (last !== undefined && last.run === run && h.from - last.holes[last.holes.length - 1]!.to <= 600 * MM && Math.abs(h.head - last.holes[0]!.head) <= 50 * MM) last.holes.push(h);
      else groups.push({ run, holes: [h] });
    }
    const curtains: string[] = [];
    const blinds: string[] = [];
    for (const g of groups) {
      const a = g.holes[0]!.from;
      const b = g.holes[g.holes.length - 1]!.to;
      const head = Math.max(...g.holes.map((h) => h.head));
      const sill = Math.min(...g.holes.map((h) => h.sill));
      const ids = g.holes.map((h) => h.id);
      // Dressed already: decor before the glass.
      const glass: Solid = { poly: [onFace(g.run.face, a, 0), onFace(g.run.face, b, 0), onFace(g.run.face, b, 150 * MM), onFace(g.run.face, a, 150 * MM)], bottom: room.floor + Math.max(sill, 0), top: room.floor + head + 120 * MM };
      if ((this.obstacles.get(room.level) ?? []).some((o) => o.what === 'decor' && interferes(glass, o))) continue;
      if (!BLINDS.has(room.function) && this.curtain(room, g.run, a, b, head, ceiling, ids)) curtains.push(...ids);
      else if (this.blind(room, g.run, a, b, head, sill, ceiling, ids)) blinds.push(...ids);
      else this.notes.push(`${room.name}: window${ids.length === 1 ? '' : 's'} ${list(ids)} left bare — no clear wall above ${ids.length === 1 ? 'it' : 'them'} for a blind.`);
    }
    if (curtains.length > 0) this.say(room, `curtains on window${curtains.length === 1 ? '' : 's'} ${list(curtains)}`);
    if (blinds.length > 0) this.say(room, `a roman blind on window${blinds.length === 1 ? '' : 's'} ${list(blinds)}`);
  }

  /** Every other window and door on a face: what a curtain's stack may not reach over. */
  private stopsOn(room: StagingRoom, run: Run, ids: readonly string[]): Hole[] {
    return room.holesInWalls.filter((h) => h.wall === run.face.wall && !ids.includes(h.id));
  }

  private curtain(room: StagingRoom, run: Run, a: number, b: number, head: number, ceiling: number, ids: readonly string[]): boolean {
    const item = 'curtains-2000';
    const X = sizeOf(item).X;
    const top = Math.min(ceiling, run.face.top - room.floor);
    const rod = top - head <= 700 * MM ? top - 100 * MM : head + 300 * MM;
    if (rod > top - 30 * MM || rod <= head) return false;
    // Each stack as wide as it may be, up to 300 mm: short of the run's ends, other windows and doors.
    const stops = this.stopsOn(room, run, ids);
    const left = Math.max(run.from, ...stops.filter((h) => h.to <= a).map((h) => h.to)) + 60 * MM;
    const right = Math.min(run.to, ...stops.filter((h) => h.from >= b).map((h) => h.from)) - 60 * MM;
    const want = Math.min(300 * MM, 0.15 * (b - a) + 150 * MM);
    const sa = Math.min(want, a - left);
    const sb = Math.min(want, right - b);
    if (sa < 100 * MM || sb < 100 * MM) return false;
    const from = a - sa;
    const to = b + sb;
    const box = boxOf(X, to - from, rod + 40 * MM);
    const mid = (from + to) / 2;
    const s = this.solidAt(faceFrame(run.face, mid), box, room.floor);
    // The floor before it clear: nothing standing within 250 mm of the face along its width.
    const zone: Solid = { poly: [onFace(run.face, from, 0), onFace(run.face, to, 0), onFace(run.face, to, 250 * MM), onFace(run.face, from, 250 * MM)], bottom: room.floor, top: room.floor + rod };
    if (this.blocked(room.level, s, null, [], DEVICES) !== undefined || this.blocked(room.level, zone, null, [], DEVICES) !== undefined) return false;
    this.placeWall(room, run, 'CURTAIN', item, mid, 0, box, `curtains on ${list(ids)}`);
    return true;
  }

  private blind(room: StagingRoom, run: Run, a: number, b: number, head: number, sill: number, ceiling: number, ids: readonly string[]): boolean {
    const item = 'blind-roman-900';
    const { X } = sizeOf(item);
    const top = Math.min(head + 100 * MM, ceiling - 20 * MM, run.face.top - room.floor - 20 * MM);
    if (top <= head) return false;
    const Z = Math.min(500 * MM, Math.max(250 * MM, (head - sill) * 0.3 + (top - head)));
    const box = boxOf(X, b - a + 120 * MM, Z);
    const mid = (a + b) / 2;
    const s = this.solidAt(faceFrame(run.face, mid), box, room.floor + top - Z);
    if (this.blocked(room.level, s, null) !== undefined) return false;
    this.placeWall(room, run, 'BLIND', item, mid, top - Z, box, `a roman blind on ${list(ids)}`);
    return true;
  }

  // ─── 2. Rugs ─────────────────────────────────────────────────────────────────────────────

  /** The seating group of a sofa: it, what is with it, and the chairs and tables near its front. */
  private group(room: StagingRoom, sofa: Piece): Piece[] {
    const front = toPlan(sofa.frame, sofa.box.max[0]!, (sofa.box.min[1]! + sofa.box.max[1]!) / 2);
    return room.pieces.filter(
      (p) =>
        p === sofa ||
        (p.root === sofa.root && p.id !== sofa.id) ||
        (p.root === p.id && ['armchair', 'coffeeTable', 'sideTable', 'stool', 'bench'].includes(p.category) && dist(centroid(p.solid.poly), front) <= 3000 * MM),
    );
  }

  /** Try rugs, biggest first, at each place: the first that fits is placed. */
  private rug(room: StagingRoom, anchor: Piece, tries: { item: string; fr: Frame }[], rule: string, need: (fr: Frame, item: string) => boolean = () => true): string | null {
    if (this.holds(room, 'rug-', anchor.root) > 0) return null;
    for (const t of tries) {
      const { X, Y, Z } = sizeOf(t.item);
      const box = boxOf(X, Y, Z);
      if (!need(t.fr, t.item)) continue;
      // Clear of the walls by 100 mm, and of every door's swing.
      if (!this.fitsFloor(room, t.fr, box, anchor.root, { entries: false, margin: 100 * MM })) continue;
      this.placeFloor(room, 'RUG', t.item, t.fr, box, rule, anchor.root);
      return t.item;
    }
    return null;
  }

  private seatingRug(room: StagingRoom, sofa: Piece): void {
    const group = this.group(room, sofa);
    const fr = sofa.frame;
    const local = group.flatMap((p) => p.solid.poly.map((q) => toLocal(fr, q)));
    const vs = local.map((q) => q[1]);
    const vc = (Math.min(...vs) + Math.max(...vs)) / 2;
    const span = Math.max(...vs) - Math.min(...vs);
    const table = group.find((p) => p.category === 'coffeeTable');
    const tries: { item: string; fr: Frame }[] = [];
    for (const item of ['rug-3000x2000', 'rug-2400x1700', 'rug-2000x1400']) {
      const { Y } = sizeOf(item);
      if (Y > span + 1000 * MM) continue;
      // Centred on the group, else slid along it a little, off a neighbouring group's space.
      for (const k of [0.45, 0.3, 0.6]) for (const dv of SHIFTS) tries.push({ item, fr: frameAt(toPlan(fr, sofa.box.min[0]! + (sofa.box.max[0]! - sofa.box.min[0]!) * k, vc + dv), fr.facing) });
    }
    const covers = (rf: Frame, item: string) => {
      if (table === undefined) return true;
      const { X, Y } = sizeOf(item);
      return table.solid.poly.every((q) => {
        const [u, v] = toLocal(rf, q);
        return u >= 150 * MM && u <= X - 150 * MM && Math.abs(v) <= Y / 2 - 150 * MM;
      });
    };
    const got = this.rug(room, sofa, tries, 'under the seating group', covers);
    if (got !== null) this.say(room, `a ${rugText(got)} rug under the seating group`);
  }

  private bedRug(room: StagingRoom, bed: Piece): void {
    const fr = bed.frame;
    const X = bed.box.max[0]! - bed.box.min[0]!;
    const W = bed.box.max[1]! - bed.box.min[1]!;
    const vc = (bed.box.min[1]! + bed.box.max[1]!) / 2;
    const order = ['rug-2400x1700', 'rug-3000x2000', 'rug-2000x1400'].sort((a, b) => {
      const fa = sizeOf(a).Y >= W + 600 * MM ? 0 : 1;
      const fb = sizeOf(b).Y >= W + 600 * MM ? 0 : 1;
      return fa - fb || sizeOf(a).Y - sizeOf(b).Y;
    });
    const tries = order.flatMap((item) => [0.3, 0.38, 0.22].flatMap((k) => SHIFTS.slice(0, 5).map((dv) => ({ item, fr: frameAt(toPlan(fr, bed.box.min[0]! + X * k, vc + dv), fr.facing) }))));
    const got = this.rug(room, bed, tries, 'under the bed', (_f, item) => sizeOf(item).Y > W);
    if (got !== null) this.say(room, `a ${rugText(got)} rug under the bed`);
  }

  private diningRug(room: StagingRoom, table: Piece): void {
    const fr = table.frame;
    const X = table.box.max[0]! - table.box.min[0]!;
    const W = table.box.max[1]! - table.box.min[1]!;
    const tries: { item: string; fr: Frame }[] = [];
    for (const item of ['rug-3000x2000', 'rug-2400x1700']) {
      const s = sizeOf(item);
      if (s.Y - W < 900 * MM || s.X - X < 900 * MM) continue;
      for (const du of SHIFTS.slice(0, 3)) for (const dv of SHIFTS.slice(0, 3)) tries.push({ item, fr: frameAt(toPlan(fr, table.box.min[0]! + X / 2 - s.X / 2 + du, (table.box.min[1]! + table.box.max[1]!) / 2 + dv), fr.facing) });
    }
    const got = this.rug(room, table, tries, 'under the dining table');
    if (got !== null) this.say(room, `a ${rugText(got)} rug under the dining table`);
  }

  /** A runner down a hall: centred on its long axis, when the hall is a rectangle long and wide enough. */
  private runner(room: StagingRoom): void {
    if (this.holds(room, 'runner-') > 0) return;
    const item = 'runner-2400x800';
    const { X, Y, Z } = sizeOf(item);
    const longest = [...room.runs].sort((a, b) => b.to - b.from - (a.to - a.from) || cmp(a.face.wall, b.face.wall))[0];
    if (longest === undefined) return;
    // The hall's frame: across it from the longest face.
    const fr0 = faceFrame(longest.face, (longest.from + longest.to) / 2);
    const local = room.outer.map((q) => toLocal(fr0, q));
    const us = local.map((q) => q[0]);
    const vs = local.map((q) => q[1]);
    const [u0, u1, v0, v1] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)];
    if (u1 - u0 < 1100 * MM || v1 - v0 < 2800 * MM || room.area < 0.8 * (u1 - u0) * (v1 - v0)) return;
    const fr = frameAt(toPlan(fr0, (u0 + u1) / 2 - X / 2, (v0 + v1) / 2), fr0.facing);
    const box = boxOf(X, Y, Z);
    if (!this.fitsFloor(room, fr, box, null, { entries: false, margin: 100 * MM })) return;
    this.placeFloor(room, 'RUG', item, fr, box, 'down the hall');
    this.say(room, 'a runner down the hall');
  }

  // ─── 3. Media ────────────────────────────────────────────────────────────────────────────

  /** The face a piece's front looks at: the run its centre line meets first, and where, within `lo`–`hi` of its front. */
  private facedRun(room: StagingRoom, p: Piece, lo: number, hi: number): { run: Run; at: number; d: number } | null {
    const fr = p.frame;
    const o = toPlan(fr, p.box.max[0]!, (p.box.min[1]! + p.box.max[1]!) / 2);
    let best: { run: Run; at: number; d: number } | null = null;
    for (const run of room.runs) {
      const f = run.face;
      // Facing it: the face's inward normal against the piece's facing.
      const dot = f.inward[0] * fr.f[0] + f.inward[1] * fr.f[1];
      if (dot > -0.98) continue;
      const { at, out } = alongFace(f, o);
      if (out < lo || out > hi || at < run.from || at > run.to) continue;
      if (best === null || out < best.d) best = { run, at, d: out };
    }
    return best;
  }

  private media(room: StagingRoom, sofa: Piece): void {
    if (room.pieces.some((p) => p.category === 'mediaUnit') || this.holds(room, 'tv-') > 0) return;
    const hit = this.facedRun(room, sofa, 2000 * MM, 5500 * MM);
    if (hit === null) return;
    const console = 'media-console-1800';
    const tv = 'tv-65';
    const c = sizeOf(console);
    const t = sizeOf(tv);
    const { run, at } = hit;
    if (at - c.Y / 2 < run.from + 100 * MM || at + c.Y / 2 > run.to + -100 * MM) return;
    // Nothing in the wall behind the television that comes down below its top.
    const top = c.Z + t.Z;
    if (room.holesInWalls.some((h) => h.wall === run.face.wall && h.to > at - c.Y / 2 - 100 * MM && h.from < at + c.Y / 2 + 100 * MM && h.sill < top + 50 * MM)) return;
    const fr = faceFrame(run.face, at, OFF_WALL);
    const cbox = boxOf(c.X, c.Y, c.Z);
    if (!this.fitsFloor(room, fr, cbox, null)) return;
    const cid = this.placeFloor(room, 'MEDIA', console, fr, cbox, 'facing the sofa');
    const tfr = frameAt(toPlan(fr, (c.X - t.X) / 2, 0), fr.facing);
    this.placeFloor(room, 'TV', tv, tfr, boxOf(t.X, t.Y, t.Z, c.Z), 'on the media console', cid);
    this.say(room, 'a media console and a television on the wall the sofa faces');
  }

  // ─── 4. Art ──────────────────────────────────────────────────────────────────────────────

  /** The run a piece's back stands against (within 200 mm, facing out of it), and where along it its middle is. */
  private backedBy(room: StagingRoom, p: Piece): { run: Run; at: number } | null {
    const fr = p.frame;
    const back = toPlan(fr, p.box.min[0]!, (p.box.min[1]! + p.box.max[1]!) / 2);
    for (const run of room.runs) {
      const f = run.face;
      if (f.inward[0] * fr.f[0] + f.inward[1] * fr.f[1] < 0.98) continue;
      const { at, out } = alongFace(f, back);
      if (out < -20 * MM || out > 200 * MM || at < run.from || at > run.to) continue;
      return { run, at };
    }
    return null;
  }

  /** Whether a wall item spanning [a, b] at heights [z0, z1] above the floor is clear: of holes, run ends, devices, swings and pieces. */
  private wallClear(room: StagingRoom, run: Run, a: number, b: number, z0: number, z1: number, margin = 100 * MM): boolean {
    if (a < run.from + margin || b > run.to - margin) return false;
    if (room.floor + z1 > run.face.top - 50 * MM) return false;
    if (room.holesInWalls.some((h) => h.wall === run.face.wall && h.to > a - margin && h.from < b + margin && h.head > z0 - margin && h.sill < z1 + margin)) return false;
    return true;
  }

  /**
   * Where a wall item can hang on a run, centred at `at`: at `bottom`, or just over an outlet or a
   * switch in its way; as wide as the item, or — for a mirror — narrowed to the wall there, down to
   * `least`. Null when the wall is not clear: a window, a door, the run's end, the ceiling or the
   * wall's own top, or something in front of it.
   */
  private hang(room: StagingRoom, run: Run, at: number, item: string, bottom: number, group: string | null, least?: number): { box: { min: number[]; max: number[] }; bottom: number } | null {
    const s = sizeOf(item);
    const ceiling = room.ceiling - room.floor;
    const widths = least === undefined ? [s.Y] : [s.Y, ...[0.9, 0.8, 0.7, 0.6].map((k) => Math.round(s.Y * k)).filter((w) => w >= least)];
    for (const w of widths) {
      let z = bottom;
      for (let tries = 0; tries < 2; tries++) {
        if (z + s.Z > ceiling - 150 * MM) break;
        if (!this.wallClear(room, run, at - w / 2, at + w / 2, z, z + s.Z, least === undefined ? 100 * MM : 40 * MM)) break;
        const box = boxOf(s.X, w, s.Z);
        const hit = this.blocked(room.level, this.solidAt(faceFrame(run.face, at), box, room.floor + z), group);
        if (hit === undefined) return { box, bottom: z };
        // An outlet or a switch under its bottom edge: hang it just clear of it.
        if (hit.what !== 'device' || hit.top - room.floor > z + 400 * MM) break;
        z = hit.top - room.floor + 60 * MM;
      }
    }
    return null;
  }

  private artOver(room: StagingRoom, p: Piece, rule: string): boolean {
    const back = this.backedBy(room, p);
    if (back === null) return false;
    const width = p.box.max[1]! - p.box.min[1]!;
    const top = p.solid.top - room.floor;
    const wide = p.category === 'sofa' || p.category === 'bed';
    const choices = wide ? (width >= 1500 * MM ? ['art-1200x800', 'art-600x800'] : ['art-600x800', 'art-500x500']) : width >= 900 * MM ? ['art-600x800', 'art-500x500'] : ['art-500x500'];
    for (const item of choices) {
      const s = sizeOf(item);
      // Its middle near eye height, 1500 mm, but never lower than a hand's span over the piece.
      const bottom = Math.max(top + (wide ? 200 * MM : 250 * MM), 1500 * MM - s.Z / 2);
      const spot = this.hang(room, back.run, back.at, item, bottom, p.root);
      if (spot === null) continue;
      this.placeWall(room, back.run, 'ART', item, back.at, spot.bottom, spot.box, rule, p.root);
      this.say(room, `framed art ${rule}`);
      return true;
    }
    return false;
  }

  private vanityMirror(room: StagingRoom, v: Piece): void {
    if (this.holds(room, 'mirror-', v.root) > 0) return;
    const back = this.backedBy(room, v);
    if (back === null) return;
    const item = 'mirror-800x1000';
    const spot = this.hang(room, back.run, back.at, item, v.solid.top - room.floor + 200 * MM, v.root, Math.min(500 * MM, v.box.max[1]! - v.box.min[1]!));
    if (spot === null) {
      this.notes.push(`${room.name}: no mirror over ${v.id} — a window, a corner or the ceiling is where it would hang.`);
      return;
    }
    this.placeWall(room, back.run, 'MIRROR', item, back.at, spot.bottom, spot.box, 'over the vanity', v.root);
    this.say(room, 'a mirror over the vanity');
  }

  /** A picture on a room's longest stretch of blank wall, nothing standing before it: an entry's, a hall's, a great room's. */
  private blankWallArt(room: StagingRoom): boolean {
    if (this.holds(room, 'art-') > 0) return false;
    const item = 'art-1200x800';
    const s = sizeOf(item);
    const bottom = 1500 * MM - s.Z / 2;
    let best: { run: Run; at: number; len: number; spot: { box: { min: number[]; max: number[] }; bottom: number } } | null = null;
    for (const run of [...room.runs].sort((a, b) => cmp(a.face.wall, b.face.wall) || a.from - b.from)) {
      const holes = room.holesInWalls.filter((h) => h.wall === run.face.wall && h.to > run.from && h.from < run.to);
      const cuts = [run.from, ...holes.flatMap((h) => [h.from, h.to]), run.to].sort((a, b) => a - b);
      for (let i = 0; i + 1 < cuts.length; i += 2) {
        const [a, b] = [cuts[i]!, cuts[i + 1]!];
        if (b - a < s.Y + 800 * MM) continue;
        const at = (a + b) / 2;
        const spot = this.hang(room, run, at, item, bottom, null);
        if (spot === null) continue;
        // Nothing standing before it — an outlet on the wall under it is no matter.
        const zone: Solid = { poly: [onFace(run.face, at - s.Y / 2, 0), onFace(run.face, at + s.Y / 2, 0), onFace(run.face, at + s.Y / 2, 400 * MM), onFace(run.face, at - s.Y / 2, 400 * MM)], bottom: room.floor + 1, top: room.floor + spot.bottom };
        if (this.blocked(room.level, zone, null, [], DEVICES) !== undefined) continue;
        if (best === null || b - a > best.len) best = { run, at, len: b - a, spot };
      }
    }
    if (best === null) return false;
    this.placeWall(room, best.run, 'ART', item, best.at, best.spot.bottom, best.spot.box, 'on the longest blank wall');
    this.say(room, 'framed art on its longest blank wall');
    return true;
  }

  // ─── 5. Lamps ────────────────────────────────────────────────────────────────────────────

  private nightstandLamp(room: StagingRoom, n: Piece): void {
    const item = 'lamp-table-600';
    const s = sizeOf(item);
    const X = n.box.max[0]! - n.box.min[0]!;
    const W = n.box.max[1]! - n.box.min[1]!;
    if (X < s.X || W < s.Y) return;
    const fr = frameAt(toPlan(n.frame, n.box.min[0]! + (X - s.X) / 2, (n.box.min[1]! + n.box.max[1]!) / 2), n.frame.facing);
    const centre = toPlan(fr, s.X / 2, 0);
    if (!this.powered(room, centre)) {
      this.notes.push(`${room.name}: no lamp on ${n.id} — no receptacle within ${String(REACH / MM / 1000)} m of it.`);
      return;
    }
    const box = boxOf(s.X, s.Y, s.Z, n.box.max[2]);
    if (this.blocked(room.level, this.solidAt(fr, box, room.floor), n.root) !== undefined) return;
    this.placeFloor(room, 'LAMP', item, fr, box, 'on the nightstand', n.root);
    this.say(room, `a table lamp on nightstand ${n.id}`);
  }

  private floorLamp(room: StagingRoom, sofa: Piece): void {
    if (this.holds(room, 'lamp-floor') > 0) return;
    const item = 'lamp-floor-1600';
    const s = sizeOf(item);
    const box = boxOf(s.X, s.Y, s.Z);
    const fr = sofa.frame;
    const X = sofa.box.max[0]! - sofa.box.min[0]!;
    const tries = [sofa.box.min[1]! - s.Y / 2 - 60 * MM, sofa.box.max[1]! + s.Y / 2 + 60 * MM].map((v) => {
      const lf = frameAt(toPlan(fr, sofa.box.min[0]! + X * 0.12, v - 0), fr.facing);
      return { lf, centre: toPlan(lf, s.X / 2, 0) };
    });
    const scored = tries
      .map((t, i) => ({ ...t, i, d: this.nearestReceptacle(room, t.centre) ?? Infinity }))
      .filter((t) => this.powered(room, t.centre))
      .sort((a, b) => a.d - b.d || a.i - b.i);
    for (const t of scored) {
      if (!this.fitsFloor(room, t.lf, box, sofa.root)) continue;
      this.placeFloor(room, 'LAMP', item, t.lf, box, 'beside the sofa', sofa.root);
      this.say(room, 'a floor lamp beside the sofa');
      return;
    }
    this.notes.push(`${room.name}: no floor lamp beside ${sofa.id} — neither end of it is free${this.r.electrical ? ' and within reach of a receptacle' : ''}.`);
  }

  private desk(room: StagingRoom, d: Piece): void {
    const X = d.box.max[0]! - d.box.min[0]!;
    const W = d.box.max[1]! - d.box.min[1]!;
    const top = d.box.max[2]!;
    const lamp = 'lamp-table-600';
    const l = sizeOf(lamp);
    if (X < l.X + 40 * MM || W < 900 * MM) return;
    const lf = frameAt(toPlan(d.frame, d.box.min[0]! + 30 * MM, d.box.max[1]! - l.Y / 2 - 40 * MM), d.frame.facing);
    const lbox = boxOf(l.X, l.Y, l.Z, top);
    if (this.powered(room, toPlan(lf, l.X / 2, 0)) && this.blocked(room.level, this.solidAt(lf, lbox, room.floor), d.root) === undefined) {
      this.placeFloor(room, 'LAMP', lamp, lf, lbox, 'on the desk', d.root);
      this.say(room, 'a table lamp on the desk');
    }
    const books = 'books-stack';
    const b = sizeOf(books);
    const bf = frameAt(toPlan(d.frame, d.box.min[0]! + 40 * MM, d.box.min[1]! + b.Y / 2 + 60 * MM), d.frame.facing);
    const bbox = boxOf(b.X, b.Y, b.Z, top);
    if (this.blocked(room.level, this.solidAt(bf, bbox, room.floor), d.root) === undefined) this.placeFloor(room, 'BOOKS', books, bf, bbox, 'on the desk', d.root);
  }

  // ─── 6. Textiles ─────────────────────────────────────────────────────────────────────────

  private sofaTextiles(room: StagingRoom, sofa: Piece, throwToo: boolean): void {
    const X = sofa.box.max[0]! - sofa.box.min[0]!;
    const Y = sofa.box.max[1]! - sofa.box.min[1]!;
    const Z = sofa.box.max[2]! - sofa.box.min[2]!;
    if (Y < 1200 * MM) return;
    const p = sofaParts(X, Y, Z);
    const c = sizeOf('cushion-450');
    const [x0, y0, z0] = sofa.box.min as [number, number, number];
    const u = x0 + p.back - 40 * MM;
    const z = z0 + p.seatTop - 40 * MM;
    let n = 0;
    for (const v of [y0 + p.arm + c.Y / 2 + 30 * MM, y0 + Y - p.arm - c.Y / 2 - 30 * MM]) {
      const fr = frameAt(toPlan(sofa.frame, u, v), sofa.frame.facing);
      const box = boxOf(c.X, c.Y, c.Z, z);
      if (this.blocked(room.level, this.solidAt(fr, box, room.floor), sofa.root) !== undefined) continue;
      this.placeFloor(room, 'CUSHION', 'cushion-450', fr, box, 'on the sofa', sofa.root);
      n++;
    }
    let thrown = false;
    if (throwToo) {
      const t = sizeOf('throw-sofa');
      const tt = Math.min(18 * MM, t.Z * 0.08);
      // Over its right arm: the throw's own right (−y) down the arm's outside.
      const fr = frameAt(toPlan(sofa.frame, x0 + X * 0.3, y0 - tt + t.Y / 2), sofa.frame.facing);
      const box = boxOf(t.X, t.Y, t.Z, z0 + p.armTop + tt - t.Z);
      if (this.blocked(room.level, this.solidAt(fr, box, room.floor), sofa.root) === undefined) {
        this.placeFloor(room, 'THROW', 'throw-sofa', fr, box, 'over the sofa\'s arm', sofa.root);
        thrown = true;
      }
    }
    if (n > 0 || thrown) this.say(room, `${n === 2 ? 'a pair of cushions' : n === 1 ? 'a cushion' : ''}${n > 0 && thrown ? ' and ' : ''}${thrown ? 'a throw over the arm' : ''} on the sofa`);
  }

  private bedTextiles(room: StagingRoom, bed: Piece): void {
    const X = bed.box.max[0]! - bed.box.min[0]!;
    const Y = bed.box.max[1]! - bed.box.min[1]!;
    const Z = bed.box.max[2]! - bed.box.min[2]!;
    const p = bedParts(X, Z);
    const [x0, y0, z0] = bed.box.min as [number, number, number];
    const c = sizeOf('cushion-450');
    const n = Y >= 1200 * MM ? 2 : 1;
    let placed = 0;
    for (let i = 0; i < n; i++) {
      const v = y0 + (Y * (2 * i + 1)) / (2 * n);
      const fr = frameAt(toPlan(bed.frame, x0 + p.pillows - 60 * MM, v), bed.frame.facing);
      const box = boxOf(c.X, c.Y, c.Z, z0 + p.mattress - 20 * MM);
      if (this.blocked(room.level, this.solidAt(fr, box, room.floor), bed.root) !== undefined) continue;
      this.placeFloor(room, 'CUSHION', 'cushion-450', fr, box, 'on the bed', bed.root);
      placed++;
    }
    const t = sizeOf('throw-bed-1640');
    const tt = Math.min(20 * MM, (Y + 40 * MM) * 0.015);
    const fr = frameAt(toPlan(bed.frame, x0 + X - t.X - 50 * MM, (y0 + y0 + Y) / 2), bed.frame.facing);
    const box = boxOf(t.X, Y + 2 * tt, t.Z, z0 + p.duvet + tt - t.Z);
    let thrown = false;
    if (this.blocked(room.level, this.solidAt(fr, box, room.floor), bed.root) === undefined) {
      this.placeFloor(room, 'THROW', 'throw-bed-1640', fr, box, 'across the foot of the bed', bed.root);
      thrown = true;
    }
    if (placed > 0 || thrown) this.say(room, `${placed > 0 ? `${placed === 2 ? 'cushions' : 'a cushion'} ` : ''}${placed > 0 && thrown ? 'and ' : ''}${thrown ? 'a throw across the foot ' : ''}on the bed`);
  }

  // ─── 7. Tabletops and counters ───────────────────────────────────────────────────────────

  /** Something set on a piece's top at local (u, v), turned `turn` microdegrees from it. */
  private onTop(room: StagingRoom, p: Piece, tag: string, item: string, u: number, v: number, turn: number, rule: string, clear = 0): boolean {
    const s = sizeOf(item);
    const centre = toPlan(p.frame, u, v);
    const fr0 = frameAt(centre, p.frame.facing + turn);
    const fr = frameAt(toPlan(fr0, -s.X / 2, 0), fr0.facing);
    const box = boxOf(s.X, s.Y, s.Z, p.box.max[2]);
    // On the top: every corner of it over the piece's footprint, 20 mm in.
    const inner = pieceRect(p, -20 * MM);
    const solid = this.solidAt(fr, box, room.floor);
    if (!within(solid.poly, inner, [])) return false;
    if (this.blocked(room.level, solid, p.root) !== undefined) return false;
    // Kept `clear` of what is set into the top or stands on it — a cooktop, a sink.
    if (clear > 0) {
      const wide: Solid = { poly: grow(solid.poly, clear), bottom: solid.bottom - 50 * MM, top: solid.top };
      if ((this.obstacles.get(room.level) ?? []).some((o) => o.owner !== p.id && o.what !== 'envelope' && o.what !== 'device' && interferes(wide, o))) return false;
    }
    this.placeFloor(room, tag, item, fr, box, rule, p.root);
    return true;
  }

  private coffeeTable(room: StagingRoom, t: Piece): void {
    const X = t.box.max[0]! - t.box.min[0]!;
    const Y = t.box.max[1]! - t.box.min[1]!;
    const x0 = t.box.min[0]!;
    const y0 = t.box.min[1]!;
    const books = this.onTop(room, t, 'BOOKS', 'books-stack', x0 + X / 2, y0 + Y * 0.28, 7_000_000, 'on the coffee table');
    const plant = this.onTop(room, t, 'PLANT', 'plant-small-350', x0 + X / 2, y0 + Y * 0.72, 0, 'on the coffee table');
    if (books || plant) this.say(room, `${books ? 'books' : ''}${books && plant ? ' and ' : ''}${plant ? 'a small plant' : ''} on the coffee table`);
  }

  private centrepiece(room: StagingRoom, t: Piece): void {
    const c = centroidLocal(t);
    if (this.onTop(room, t, 'VASE', 'vase-stems-450', c[0], c[1], 0, 'on the dining table')) this.say(room, 'a vase of stems on the dining table');
  }

  private islandBowl(room: StagingRoom, island: Piece): void {
    if (this.holds(room, 'bowl-fruit', island.root) > 0) return;
    const X = island.box.max[0]! - island.box.min[0]!;
    const Y = island.box.max[1]! - island.box.min[1]!;
    // Toward an end, clear of a cooktop or a sink set into it by 100 mm.
    for (const k of [0.12, 0.88, 0.2, 0.8, 0.5])
      if (this.onTop(room, island, 'BOWL', 'bowl-fruit-320', island.box.min[0]! + X * 0.55, island.box.min[1]! + Y * k, 0, 'on the island', 100 * MM)) {
        this.say(room, 'a fruit bowl on the island');
        return;
      }
  }

  /**
   * Counters: base cabinets against a wall, side by side, are a run; along each run's back, clear of
   * sinks, cooktops and ranges by 150 mm, canisters in a corner, a cutting board, a kettle.
   */
  private counters(room: StagingRoom): void {
    const bases = room.pieces.filter((p) => p.category === 'baseCabinet' && this.backedBy(room, p) !== null);
    const runs: { face: Run; pieces: Piece[]; from: number; to: number }[] = [];
    for (const b of bases) {
      const back = this.backedBy(room, b)!;
      const w = b.box.max[1]! - b.box.min[1]!;
      const [a, z] = [back.at - w / 2, back.at + w / 2];
      const r = runs.find((x) => x.face.face.wall === back.run.face.wall && x.face.face.side === back.run.face.side && a <= x.to + 20 * MM && z >= x.from - 20 * MM);
      if (r === undefined) runs.push({ face: back.run, pieces: [b], from: a, to: z });
      else {
        r.pieces.push(b);
        r.from = Math.min(r.from, a);
        r.to = Math.max(r.to, z);
      }
    }
    runs.sort((a, b) => b.to - b.from - (a.to - a.from) || cmp(a.pieces[0]!.id, b.pieces[0]!.id));
    const placed: string[] = [];
    const want = ['canisters-3', 'cutting-board-450', 'kettle', 'plant-small-350'];
    const words: Record<string, [string, string]> = { 'canisters-3': ['CANISTERS', 'canisters'], 'cutting-board-450': ['BOARD', 'a cutting board'], kettle: ['KETTLE', 'a kettle'], 'plant-small-350': ['PLANT', 'a small plant'] };
    for (const [i, item] of want.entries()) {
      if (this.holds(room, item) > 0) continue;
      const s = sizeOf(item);
      let done = false;
      // Each on the next run in turn, so they spread along the kitchen rather than crowd one counter.
      for (const run of runs.map((_, k) => runs[(k + i) % runs.length]!)) {
        if (done) break;
        const steps = item === 'canisters-3' ? [run.to - s.Y / 2 - 40 * MM, run.from + s.Y / 2 + 40 * MM] : [0.3, 0.7, 0.5, 0.15, 0.85].map((k) => run.from + (run.to - run.from) * k);
        for (const at of steps) {
          const under = run.pieces.find((p) => {
            const back = this.backedBy(room, p)!;
            const w = p.box.max[1]! - p.box.min[1]!;
            return at >= back.at - w / 2 && at <= back.at + w / 2;
          });
          if (under === undefined) continue;
          const fr = faceFrame(run.face.face, at, 40 * MM);
          const box = boxOf(s.X, s.Y, s.Z, under.solid.top - room.floor);
          const solid = this.solidAt(fr, box, room.floor);
          // Clear of sinks and cooktops by 150 mm, and of what else is on the counter.
          const wide: Solid = { poly: grow(solid.poly, 150 * MM), bottom: solid.bottom - 200 * MM, top: solid.top };
          const near = (this.obstacles.get(room.level) ?? []).some((o) => (o.what === 'fixture' || o.what === 'decor' || (o.what === 'furniture' && ['cooktop', 'range'].includes(this.r.pieces.get(o.owner)?.category ?? ''))) && o.top > wide.bottom && o.bottom < wide.top && polysOverlap(wide.poly, o.poly));
          if (near) continue;
          if (this.blocked(room.level, solid, under.root) !== undefined) continue;
          if (item === 'kettle' && !this.powered(room, toPlan(fr, s.X / 2, 0))) continue;
          this.placeFloor(room, words[item]![0], item, fr, box, 'on the counter', under.root);
          placed.push(words[item]![1]);
          done = true;
          break;
        }
      }
    }
    if (placed.length > 0) this.say(room, `${list(placed)} on the counters`);
  }

  private vanityTop(room: StagingRoom, v: Piece): void {
    if (this.holds(room, 'soap-set', v.root) > 0) return;
    const X = v.box.max[0]! - v.box.min[0]!;
    const Y = v.box.max[1]! - v.box.min[1]!;
    for (const k of [0.82, 0.18])
      if (this.onTop(room, v, 'SOAP', 'soap-set', v.box.min[0]! + X * 0.22, v.box.min[1]! + Y * k, 0, 'on the vanity')) {
        this.say(room, 'a soap set on the vanity');
        return;
      }
  }

  // ─── 8. Baths ────────────────────────────────────────────────────────────────────────────

  private towelBar(room: StagingRoom): void {
    if (this.holds(room, 'towel-bar') > 0) return;
    const item = 'towel-bar-600';
    const s = sizeOf(item);
    const height = 1000 * MM;
    const fixtures = (this.obstacles.get(room.level) ?? []).filter((o) => o.what === 'fixture' && inRoom(room, centroid(o.poly)));
    const tub = fixtures.find((o) => /tub|shower/i.test(fixtureOf(this.doc, o.owner)));
    const target = tub === undefined ? room.pieces.find((p) => p.category === 'vanity')?.solid.poly : tub.poly;
    const candidates: { run: Run; at: number; score: number }[] = [];
    for (const run of [...room.runs].sort((a, b) => cmp(a.face.wall, b.face.wall) || a.from - b.from))
      for (let at = run.from + s.Y / 2 + 150 * MM; at <= run.to - s.Y / 2 - 150 * MM; at += 150 * MM) {
        if (!this.wallClear(room, run, at - s.Y / 2, at + s.Y / 2, height, height + s.Z)) continue;
        const box = boxOf(s.X, s.Y, s.Z);
        const solid = this.solidAt(faceFrame(run.face, at), box, room.floor + height);
        if (this.blocked(room.level, solid, null) !== undefined) continue;
        // Nothing taller than knee height in front of it.
        const front: Solid = { poly: [onFace(run.face, at - s.Y / 2, 0), onFace(run.face, at + s.Y / 2, 0), onFace(run.face, at + s.Y / 2, 500 * MM), onFace(run.face, at - s.Y / 2, 500 * MM)], bottom: room.floor + 600 * MM, top: room.floor + height };
        if (this.blocked(room.level, front, null) !== undefined) continue;
        const p = onFace(run.face, at, 0);
        candidates.push({ run, at, score: target === undefined ? 0 : dist(p, centroid(target)) });
      }
    candidates.sort((a, b) => a.score - b.score || cmp(a.run.face.wall, b.run.face.wall) || a.at - b.at);
    const best = candidates[0];
    if (best === undefined) return;
    this.placeWall(room, best.run, 'TOWEL', item, best.at, height, boxOf(s.X, s.Y, s.Z), tub === undefined ? 'beside the vanity' : 'beside the bath');
    this.say(room, `a towel bar ${tub === undefined ? 'near the vanity' : 'near the bath'}`);
  }

  private bathMat(room: StagingRoom): void {
    if (this.holds(room, 'bath-mat') > 0) return;
    const item = 'bath-mat-800x500';
    const s = sizeOf(item);
    const box = boxOf(s.X, s.Y, s.Z);
    const fixtures = (this.obstacles.get(room.level) ?? []).filter((o) => o.what === 'fixture' && /tub|shower/i.test(fixtureOf(this.doc, o.owner)) && inRoom(room, centroid(o.poly)));
    const fronts: { fr: Frame; group: string | null; rule: string }[] = [];
    for (const f of fixtures.sort((a, b) => cmp(a.owner, b.owner))) {
      const pl = this.r.derived.placements?.[f.owner];
      const box3 = this.r.derived.fallbacks?.[f.owner];
      if (pl === undefined || box3 === undefined) continue;
      const fr = frameAt([pl.point[0], pl.point[1]], pl.facing);
      const local = f.poly.map((q) => toLocal(fr, q));
      const u1 = Math.max(...local.map((q) => q[0]));
      const vc = (Math.min(...local.map((q) => q[1])) + Math.max(...local.map((q) => q[1]))) / 2;
      fronts.push({ fr: frameAt(toPlan(fr, u1 + 40 * MM, vc), fr.facing), group: null, rule: 'before the bath' });
    }
    for (const v of room.pieces.filter((p) => p.category === 'vanity')) fronts.push({ fr: frameAt(toPlan(v.frame, v.box.max[0]! + 60 * MM, (v.box.min[1]! + v.box.max[1]!) / 2), v.frame.facing), group: v.root, rule: 'before the vanity' });
    for (const t of fronts) {
      if (!this.fitsFloor(room, t.fr, box, t.group, { entries: false })) continue;
      this.placeFloor(room, 'MAT', item, t.fr, box, t.rule, t.group ?? undefined);
      this.say(room, `a bath mat ${t.rule}`);
      return;
    }
  }

  // ─── 9. Plants ───────────────────────────────────────────────────────────────────────────

  /** The room's corners that walls make on both sides: each with the two faces, best first. */
  private corners(room: StagingRoom, want: number): void {
    const count = want - this.holds(room, 'plant-tree') - this.holds(room, 'plant-floor');
    if (count <= 0) return;
    const ring = room.outer;
    const n = ring.length;
    let signed = 0;
    for (let i = 0; i < n; i++) signed += ring[i]![0] * ring[(i + 1) % n]![1] - ring[(i + 1) % n]![0] * ring[i]![1];
    const ccw = signed > 0;
    const walled = (p: P): boolean =>
      room.runs.some((r) => {
        const { at, out } = alongFace(r.face, p);
        return Math.abs(out) <= 5 * MM && at >= r.from - 5 * MM && at <= r.to + 5 * MM;
      });
    const spots: { p: P; e1: P; e2: P; score: number; i: number }[] = [];
    for (let i = 0; i < n; i++) {
      const p = ring[i]!;
      const a = ring[(i + n - 1) % n]!;
      const b = ring[(i + 1) % n]!;
      const l1 = dist(a, p);
      const l2 = dist(b, p);
      if (l1 < 900 * MM || l2 < 900 * MM) continue;
      const e1: P = [(a[0] - p[0]) / l1, (a[1] - p[1]) / l1];
      const e2: P = [(b[0] - p[0]) / l2, (b[1] - p[1]) / l2];
      // Convex, and square within a few degrees.
      const turn = (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]);
      if ((turn > 0) !== ccw || Math.abs(e1[0] * e2[0] + e1[1] * e2[1]) > 0.1) continue;
      if (!walled([p[0] + e1[0] * 400 * MM, p[1] + e1[1] * 400 * MM]) || !walled([p[0] + e2[0] * 400 * MM, p[1] + e2[1] * 400 * MM])) continue;
      const entries = entryZones(room).map((z) => centroid(z.poly));
      const away = entries.length === 0 ? 0 : Math.min(...entries.map((q) => dist(q, p)));
      const lit = room.holesInWalls.some((h) => h.kind === 'window' && room.runs.some((r) => r.face.wall === h.wall && dist(onFace(r.face, (h.from + h.to) / 2), p) <= 2000 * MM));
      spots.push({ p, e1, e2, score: away + (lit ? 1500 * MM : 0), i });
    }
    spots.sort((a, b) => b.score - a.score || a.i - b.i);
    const tall = room.ceiling - room.floor >= 2400 * MM && room.area >= 14 * M2;
    const items = tall ? ['plant-tree-1700', 'plant-floor-900'] : ['plant-floor-900', 'plant-floor-900'];
    let placed = 0;
    const said: string[] = [];
    for (const spot of spots) {
      if (placed >= count) break;
      let done = false;
      for (const item of items.slice(placed, placed + 1).concat(placed === 0 && tall ? ['plant-floor-900'] : [])) {
        if (done) break;
        const s = sizeOf(item);
        // Snug in the corner, or stood off a wall far enough to clear a curtain's stack hung there.
        for (const [o1, o2] of CORNER_OFFSETS) {
          // Square to the walls: its back to the wall along e1 (o1 off it), its side o2 off the wall along e2.
          const back = [spot.p[0] + spot.e1[0] * (o2 + s.Y / 2) + spot.e2[0] * o1, spot.p[1] + spot.e1[1] * (o2 + s.Y / 2) + spot.e2[1] * o1] as P;
          const fr = frameAt(back, directionOf(spot.e2));
          const box = boxOf(s.X, s.Y, s.Z);
          if (!this.fitsFloor(room, fr, box, null)) continue;
          this.placeFloor(room, 'PLANT', item, fr, box, 'in a corner');
          said.push(item.startsWith('plant-tree') ? 'an indoor tree' : 'a floor plant');
          placed++;
          done = true;
          break;
        }
      }
    }
    if (said.length > 0) this.say(room, `${list(said)} in ${said.length === 1 ? 'a corner' : 'its corners'}`);
  }
}

/** A facing for a unit vector, exactly as the engine reads the integer vector nearest it (microdegrees). */
function directionOf(e: P): number {
  return direction(BigInt(Math.round(e[0] * 1e9)), BigInt(Math.round(e[1] * 1e9)));
}


/** The middle of a piece's box, in its own frame. */
function centroidLocal(p: Piece): P {
  return [(p.box.min[0]! + p.box.max[0]!) / 2, (p.box.min[1]! + p.box.max[1]!) / 2];
}

/** A plumbing fixture's kind, or ''. */
function fixtureOf(doc: FloorspecDocument, id: string): string {
  const plumbing = (doc.extensions as Json | undefined)?.['FS_plumbing'] as Json | undefined;
  const fixtures = (plumbing?.['collections'] as Json | undefined)?.['fixtures'] as Record<string, Json> | undefined;
  const f = fixtures !== undefined && Object.hasOwn(fixtures, id) ? fixtures[id]?.['fixture'] : undefined;
  return typeof f === 'string' ? f : '';
}

const rugText = (item: string): string => {
  const m = /(\d+)x(\d+)/.exec(item);
  return m === null ? item : `${m[1]!} × ${m[2]!} mm`;
};

/** Every ID the document uses, records included: what a new element must not be called. */
export function usedIds(doc: FloorspecDocument): Set<string> {
  const used = new Set<string>();
  const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
  for (const [key, c] of Object.entries(doc as unknown as Json)) {
    if (key === 'extensions' || key === 'program' || !isObj(c)) continue;
    for (const k of Object.keys(c)) used.add(k);
  }
  const items = (doc.program as Json | undefined)?.['items'];
  if (isObj(items)) for (const k of Object.keys(items)) used.add(k);
  for (const data of Object.values((doc.extensions ?? {}) as Json)) {
    if (!isObj(data)) continue;
    for (const [member, value] of Object.entries(data)) {
      if (!isObj(value)) continue;
      if (member === 'collections') {
        for (const coll of Object.values(value)) if (isObj(coll)) for (const k of Object.keys(coll)) used.add(k);
      } else for (const k of Object.keys(value)) used.add(k);
    }
  }
  return used;
}
