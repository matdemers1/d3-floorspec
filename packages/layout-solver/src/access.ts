/**
 * The access planner: which rooms open into which, and through what.
 *
 * The living spaces and halls form the house's circulation network — joined by separators in an
 * open plan (Core §5.2: a boundary with nothing built) or by cased openings in walled rooms. Every
 * other room then takes one door, greedily, best first, onto the room it most sensibly opens off:
 * a bath en suite to its bedroom, a bedroom onto the hall, a laundry off the kitchen, a closet off
 * its bedroom. A bedroom never opens off another bedroom, and nothing but a closet is entered
 * through a bath. A layout in which some room cannot be reached from the front door is dropped.
 */
import { between, isExterior, insideOf, pairKey, type Layout, type Seg, type Space } from './layout.js';
import { OPEN_FUNCTIONS } from './program.js';
import { ftG } from './units.js';

export type ConnKind = 'open' | 'cased' | 'door';

/** What fills a door, by size: a passage door, a closet door, the front door, a garage door. */
export type DoorKind = 'passage' | 'closet' | 'entry' | 'garage';

export interface Conn {
  readonly a: string;
  readonly b: string;
  readonly kind: ConnKind;
  /** For a door or cased opening: the segment it is in. Separators take every shared segment. */
  readonly seg?: Seg;
  /** For a door: the room it is a door of (it swings into it); for a cased opening, its width in inches. */
  readonly into?: string;
  readonly door?: DoorKind;
  readonly width?: number;
}

export interface Access {
  readonly entry: { readonly space: string; readonly seg: Seg };
  readonly garageDoor?: { readonly space: string; readonly seg: Seg };
  readonly conns: Conn[];
  /** Segments drawn as separators rather than walls. */
  readonly separators: ReadonlySet<Seg>;
  /** Each space's name: the closets the solver added are named for the room they open off. */
  readonly names: ReadonlyMap<string, string>;
}

const CLOSET_NAME: Readonly<Record<string, string>> = { circulation: 'Coat closet', living: 'Coat closet', dining: 'Coat closet', kitchen: 'Pantry', sleeping: 'Closet' };

/** Names for the solver's closets by what they open off — "Linen closet" off a hall — numbered when repeated. */
function names(layout: Layout, conns: readonly Conn[]): Map<string, string> {
  const byKey = new Map(layout.spaces.map((s) => [s.key, s]));
  const out = new Map<string, string>();
  const base = new Map<string, string>();
  for (const s of layout.spaces) {
    if (s.kind !== 'closet') {
      out.set(s.key, s.name);
      continue;
    }
    const door = conns.find((c) => c.kind === 'door' && c.into === s.key);
    const nb = door === undefined ? undefined : byKey.get(door.a);
    base.set(s.key, nb === undefined ? 'Storage' : nb.kind === 'hall' ? 'Linen closet' : (CLOSET_NAME[nb.fn] ?? 'Storage'));
  }
  const taken = new Set(out.values());
  const seen = new Map<string, number>();
  for (const [k, b] of base) {
    const total = [...base.values()].filter((x) => x === b).length + (taken.has(b) ? 1 : 0);
    const n = (seen.get(b) ?? 0) + 1;
    seen.set(b, n);
    out.set(k, total > 1 ? `${b} ${String(n)}` : b);
  }
  return out;
}

/** Clear width of each door, in inches. */
export const DOOR_WIDTH: Readonly<Record<DoorKind, number>> = { passage: 32, closet: 24, entry: 36, garage: 192 };
/**
 * Distance kept between an opening and an end of its wall, in inches: past the join there (Core
 * §7.5) — an exterior wall reaches 7 1/4" into a wall that meets it, a partition 2 1/4".
 */
export const marginAt = (out: boolean): number => (out ? 9 : 4.5);

/** Whether a segment takes an opening `inches` wide, clear of the joins at both ends. */
export const fits = (seg: Seg, inches: number): boolean => seg.length * 6 >= inches + marginAt(seg.aOut) + marginAt(seg.bOut);

const isHall = (s: Space): boolean => s.kind === 'hall' || s.fn === 'circulation';
const isOpen = (s: Space): boolean => OPEN_FUNCTIONS.has(s.fn);
export const inNetwork = (s: Space): boolean => isHall(s) || isOpen(s);

const NEVER = -1;

/** How well `leaf` opens off `nb`: higher is better, NEVER is not allowed. */
function priority(leaf: Space, nb: Space): number {
  if (leaf.req?.host !== undefined && leaf.req.host === nb.key) return 100;
  if (leaf.kind === 'closet') {
    if (nb.fn === 'sleeping') return 90;
    if (isHall(nb)) return 70;
    if (isOpen(nb)) return 50;
    if (nb.fn === 'garage') return 30;
    return 40;
  }
  if (nb.fn === 'sleeping') return leaf.fn === 'storage' ? 30 : leaf.fn === 'bath' ? 5 : NEVER;
  if (nb.kind === 'hall') return leaf.fn === 'garage' ? 40 : 90;
  if (nb.fn === 'circulation') return leaf.fn === 'garage' ? 95 : 80;
  if (nb.fn === 'living' || nb.fn === 'dining') {
    const p: Record<string, number> = { sleeping: 40, bath: 45, office: 60, laundry: 30, utility: 30, storage: 40, mechanical: 30, garage: 15 };
    return p[leaf.fn] ?? 30;
  }
  if (nb.fn === 'kitchen') {
    const p: Record<string, number> = { laundry: 70, utility: 65, storage: 65, garage: 70, mechanical: 40, office: 25, bath: 20, sleeping: 10 };
    return p[leaf.fn] ?? 15;
  }
  if (nb.fn === 'garage') return leaf.fn === 'storage' || leaf.fn === 'mechanical' || leaf.fn === 'utility' ? 40 : NEVER;
  if (nb.fn === 'laundry' || nb.fn === 'utility') {
    if (leaf.fn === 'sleeping') return NEVER;
    const p: Record<string, number> = { garage: 90, mechanical: 60, storage: 50, bath: 15 };
    return p[leaf.fn] ?? 10;
  }
  if (nb.fn === 'bath') return leaf.fn === 'storage' ? 20 : NEVER;
  return leaf.fn === 'storage' || leaf.fn === 'mechanical' ? 20 : NEVER;
}

const doorFor = (leaf: Space): DoorKind => (leaf.fn === 'storage' || leaf.fn === 'mechanical' ? 'closet' : 'passage');

/** The longest of the segments that takes an opening `inches` wide, or undefined. */
function longestFitting(segs: readonly Seg[], inches: number): Seg | undefined {
  let best: Seg | undefined;
  for (const s of segs) if (fits(s, inches) && (best === undefined || s.length > best.length)) best = s;
  return best;
}

const ENTRY_PREFERENCE: Readonly<Record<string, number>> = { circulation: 100, living: 80, dining: 60, kitchen: 40 };
/** Rooms a front door may open into when the house has no living spaces at all. */
const LAST_RESORT_ENTRY: ReadonlySet<string> = new Set(['office', 'utility', 'laundry', 'unspecified']);

/** Plan the access of a layout over its segments. Undefined when some room cannot be reached. */
export function planAccess(layout: Layout, segs: readonly Seg[]): Access | undefined {
  const byKey = new Map(layout.spaces.map((s) => [s.key, s]));
  const conns: Conn[] = [];
  const separators = new Set<Seg>();
  const shared = (p: string, q: string): Seg[] => between(segs, p, q);
  const neighbours = new Map<string, string[]>();
  for (const s of segs) {
    if (s.left === undefined || s.right === undefined) continue;
    for (const [p, q] of [
      [s.left, s.right],
      [s.right, s.left],
    ] as const) {
      const list = neighbours.get(p) ?? [];
      if (!list.includes(q)) list.push(q);
      neighbours.set(p, list);
    }
  }
  for (const list of neighbours.values()) list.sort();

  // The front door: on the south face if it can be, into an entry, else the living spaces.
  let entry: { space: string; seg: Seg; score: number } | undefined;
  for (const seg of segs) {
    if (!isExterior(seg) || !fits(seg, DOOR_WIDTH.entry)) continue;
    const space = byKey.get(insideOf(seg))!;
    const pref = space.kind === 'hall' ? 50 : (ENTRY_PREFERENCE[space.fn] ?? (LAST_RESORT_ENTRY.has(space.fn) ? 10 : undefined));
    if (pref === undefined) continue;
    const south = seg.horizontal && seg.a[1] === 0;
    const score = pref + (south ? 30 : 0) + seg.length / 100;
    if (entry === undefined || score > entry.score) entry = { space: space.key, seg, score };
  }
  if (entry === undefined) return undefined;

  // The circulation network.
  const net = layout.spaces.filter(inNetwork);
  for (let i = 0; i < net.length; i++)
    for (let j = i + 1; j < net.length; j++) {
      const p = net[i]!;
      const q = net[j]!;
      const ss = shared(p.key, q.key);
      const len = ss.reduce((t, s) => t + s.length, 0);
      if (len < ftG(3)) continue;
      const hallEnd = (isHall(p) || isHall(q)) && len <= ftG(5);
      const open = hallEnd || (isHall(p) && isHall(q)) || layout.openPlan;
      if (open) {
        for (const s of ss) separators.add(s);
        conns.push({ a: p.key, b: q.key, kind: 'open' });
        continue;
      }
      const width = isHall(p) || isHall(q) ? 36 : 72;
      const seg = longestFitting(ss, 36);
      if (seg === undefined) {
        for (const s of ss) separators.add(s);
        conns.push({ a: p.key, b: q.key, kind: 'open' });
        continue;
      }
      const w = Math.min(width, Math.floor((seg.length * 6 - marginAt(seg.aOut) - marginAt(seg.bOut)) / 6) * 6);
      conns.push({ a: p.key, b: q.key, kind: 'cased', seg, width: w });
    }

  // Every other room: one door each, best first.
  const reached = new Set<string>();
  const adj = new Map<string, Set<string>>();
  const link = (p: string, q: string): void => {
    for (const [x, y] of [
      [p, q],
      [q, p],
    ] as const) {
      const set = adj.get(x) ?? new Set<string>();
      set.add(y);
      adj.set(x, set);
    }
  };
  for (const c of conns) link(c.a, c.b);
  const flood = (from: string): void => {
    const todo = [from];
    while (todo.length > 0) {
      const k = todo.pop()!;
      if (reached.has(k)) continue;
      reached.add(k);
      for (const n of [...(adj.get(k) ?? [])].sort()) todo.push(n);
    }
  };
  flood(entry.space);
  const leaves = layout.spaces.filter((s) => !inNetwork(s)).map((s) => s.key);
  for (;;) {
    let best: { leaf: string; nb: string; p: number; seg: Seg; door: DoorKind } | undefined;
    for (const lk of leaves) {
      if (reached.has(lk)) continue;
      const leaf = byKey.get(lk)!;
      const door = doorFor(leaf);
      // An en-suite room waits for its bedroom when it can open off it.
      const host = leaf.req?.host;
      const waits = host !== undefined && longestFitting(shared(lk, host), DOOR_WIDTH[door]) !== undefined;
      for (const nk of neighbours.get(lk) ?? []) {
        if (!reached.has(nk) || (waits && nk !== host)) continue;
        const p = priority(leaf, byKey.get(nk)!);
        if (p === NEVER) continue;
        const seg = longestFitting(
          shared(lk, nk).filter((s) => !separators.has(s)),
          DOOR_WIDTH[door],
        );
        if (seg === undefined) continue;
        if (best === undefined || p > best.p) best = { leaf: lk, nb: nk, p, seg, door };
      }
    }
    if (best === undefined) break;
    conns.push({ a: best.nb, b: best.leaf, kind: 'door', seg: best.seg, into: best.leaf, door: best.door });
    link(best.nb, best.leaf);
    flood(best.leaf);
  }
  if (layout.spaces.some((s) => !reached.has(s.key))) return undefined;

  // A garage gets its overhead door on its longest outside face, the front if it can.
  let garageDoor: { space: string; seg: Seg } | undefined;
  for (const g of layout.spaces.filter((s) => s.fn === 'garage')) {
    const outs = segs.filter((s) => isExterior(s) && insideOf(s) === g.key && s.length >= ftG(10));
    const front = outs.filter((s) => s.horizontal && s.a[1] === 0);
    const seg = longestFitting(front.length > 0 ? front : outs, 96);
    if (seg !== undefined) garageDoor = { space: g.key, seg };
  }
  return { entry: { space: entry.space, seg: entry.seg }, ...(garageDoor === undefined ? {} : { garageDoor }), conns, separators, names: names(layout, conns) };
}

/** The connected pairs a plan intends (for the quick pre-score, before the engine measures them). */
export function plannedPairs(access: Access): Set<string> {
  return new Set(access.conns.map((c) => pairKey(c.a, c.b)));
}
