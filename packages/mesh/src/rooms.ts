/**
 * Floors, ceilings and slabs (Core 0.3, chapter 15), from the derived room polygons, floors,
 * ceilings and slabs.
 *
 * - A floor with a thickness is a solid prism of its room polygon from its bottom to its top; a
 *   floor with none ("not declared", 15.1) is a surface facing up at its top — on the lowest level.
 *   On a level with a level below, a floor that declares no thickness is drawn down to the ceiling
 *   below it (FLR-T-12.32, `plenumsOf`): a solid from its top to just above that ceiling, so it is
 *   seen from below, its edges close the band between the ceiling below and the floor where it
 *   borders a void or a double-height room, and what stands on it does not float; or, where there
 *   is no depth to fill, a surface facing both ways. Its derived floor (15.1) is unchanged: the
 *   depth is the view's, not the standard's (a mesh is not normative, Core 0.5).
 * - A ceiling is a surface (15.5: "a ceiling is a surface") facing down: flat at E + h; a tray's
 *   border at E + h, its centre at E + h + depth, and the vertical step between them facing the
 *   border; a vault as the room polygon lifted to z(P) — split along the ridge line for a ceiling
 *   that falls both ways, so each triangle lies in one plane — every vertex's elevation the exact
 *   z(P) rounded once, as the engine rounds the ceiling's low and high.
 * - A slab is a solid prism of its outline from its bottom to its top.
 * - An outdoor room — function `exterior` (4.1): a deck, a patio, a balcony — gets no ceiling where
 *   nothing is over it: no roof, no room of a higher level and no slab a metre or more above its
 *   floor covers half of it or more in plan (FLR-T-12.23). Its derived ceiling (15.5) is unchanged;
 *   it is only not drawn, so a roof deck is open to the sky and a porch under a roof keeps its ceiling.
 */
import { Surd, type Derived, type FloorspecDocument, type Room, type VaultedCeiling } from '@floorspec/engine';
import { get } from './own.js';
import { MeshBuilder, type P2, type P3 } from './builder.js';
import { scoped, type CrossSection, type Kernel } from './kernel.js';
import type { RawPart } from './part.js';
import { UNITS_PER_METRE, type Plenum } from './types.js';

type Ring = readonly P2[];

const reversed = (r: Ring): P2[] => [...r].reverse();

/** E + h: the elevation of a flat ceiling, a tray's border and a vault's ridge (15.2). */
function ceilingBase(doc: FloorspecDocument, room: Room): bigint {
  const L = get(doc.levels, room.level)!;
  return BigInt(L.elevation) + BigInt(room.ceiling?.height ?? L.ceilingHeight ?? L.height);
}

/** 15.3: the cross c(P), times √D, of a plan point with the ridge line. */
function cross(c: VaultedCeiling, p: P2): bigint {
  const [[ax, ay], [bx, by]] = c.ridge;
  return BigInt(bx - ax) * (BigInt(p[1]) - BigInt(ay)) - BigInt(by - ay) * (BigInt(p[0]) - BigInt(ax));
}

/** 15.3: the vault's exact elevation at an integer plan point, rounded once. */
function vaultZ(base: bigint, c: VaultedCeiling, p: P2): number {
  const [[ax, ay], [bx, by]] = c.ridge;
  const dx = BigInt(bx - ax);
  const dy = BigInt(by - ay);
  const D = dx * dx + dy * dy;
  const x = cross(c, p);
  const slopes = c.slopes ?? 'both';
  const f = slopes === 'both' ? (x < 0n ? -x : x) : slopes === 'left' ? x : -x;
  return Number(Surd.sqrt(D).mulInt(-BigInt(c.pitch.rise) * f).divInt(BigInt(c.pitch.run) * D).addInt(base).round());
}

/**
 * A floor's plan rings between its bottom and its top: a solid prism when it has a depth; else a
 * surface facing up at its top — and down too, for a floor drawn down to the ceiling below with no
 * depth to fill (FLR-T-12.32). Shared with the doorways' thresholds (thresholds.ts).
 */
export function floorBody(kernel: Kernel, rings: readonly Ring[], top: number, bottom: number, plenum: Plenum | undefined): Pick<RawPart, 'closed' | 'facing' | 'plenum'> & { exact: MeshBuilder } {
  const b = new MeshBuilder(kernel);
  const z0 = plenum?.bottom ?? bottom;
  const closed = top > z0;
  if (closed) b.prism(rings, z0, top);
  else {
    b.sheet(rings, top, 'up');
    if (plenum !== undefined) b.sheet(rings, top, 'down');
  }
  return { closed, ...(closed ? {} : { facing: plenum === undefined ? ('up' as const) : ('both' as const) }), ...(plenum === undefined ? {} : { plenum }), exact: b };
}

export function roomParts(kernel: Kernel, doc: FloorspecDocument, derived: Derived, want: (kind: RawPart['kind']) => boolean, plenums: ReadonlyMap<string, Plenum> = new Map()): RawPart[] {
  const out: RawPart[] = [];
  for (const id of Object.keys(derived.rooms).sort()) {
    const room = get(doc.rooms, id);
    const poly = derived.rooms[id]!;
    if (!room) continue;
    const rings: Ring[] = [poly.outer, ...poly.holes];
    const fl = derived.floors?.[id];
    if (fl && want('floor')) out.push({ kind: 'floor', id, level: room.level, ...floorBody(kernel, rings, fl.top, fl.bottom, plenums.get(id)) });
    const ce = derived.ceilings?.[id];
    if (ce && want('ceiling') && !(room.function === 'exterior' && openToSky(kernel, doc, derived, id))) {
      const b = new MeshBuilder(kernel);
      const c = room.ceiling ?? { kind: 'flat' };
      const base = Number(ceilingBase(doc, room));
      if (c.kind === 'tray' && ce.tray) {
        const top = base + c.depth;
        const centre: Ring[] = [ce.tray.outer, ...ce.tray.holes];
        // The border: the room polygon with the centre's rings as holes — its outer ring reversed
        // into a hole, each of its holes reversed into an island around the room's hole.
        b.sheet([...rings, ...centre.map(reversed)], base, 'down');
        b.sheet(centre, top, 'down');
        // The step, on every edge of every ring of the centre, facing out of the centre: to the
        // right of the ring's walk, which runs counter-clockwise outside and clockwise round a hole.
        for (const r of centre)
          for (let i = 0; i < r.length; i++) {
            const p = r[i]!;
            const q = r[(i + 1) % r.length]!;
            b.quad([p[0], p[1], base], [q[0], q[1], base], [q[0], q[1], top], [p[0], p[1], top]);
          }
      } else if (c.kind === 'vaulted') {
        vault(kernel, b, rings, c, ceilingBase(doc, room));
      } else b.sheet(rings, base, 'down');
      out.push({ kind: 'ceiling', id, level: room.level, closed: false, facing: 'down', exact: b });
    }
  }
  if (want('slab'))
    for (const id of Object.keys(derived.slabs ?? {}).sort()) {
      const s = derived.slabs![id]!;
      const slab = get(doc.slabs, id)!;
      const b = new MeshBuilder(kernel);
      b.prism([s.outline], s.bottom, s.top);
      out.push({ kind: 'slab', id, level: slab.level, closed: true, ...(slab.material !== undefined && { material: slab.material }), exact: b });
    }
  return out;
}

/** Twice a ring's signed area, in square base units (as doubles: a test of half the room, not a measure). */
function area2(ring: Ring): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1];
  return a;
}

/** How far over an outdoor room's floor something must be to cover it: a metre, in base units. */
const OVER = 1_280_000;

/** A ring as a counter-clockwise plan polygon relative to `o`, for manifold-3d. */
function ccw(ring: Ring, o: P2): [number, number][] {
  const pts = ring.map((p): [number, number] => [p[0] - o[0], p[1] - o[1]]);
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j]![0] * pts[i]![1] - pts[i]![0] * pts[j]![1];
  return a < 0 ? pts.reverse() : pts;
}

/** The area two plan polygons (outer rings) share, in square base units. */
function shared(kernel: Kernel, a: Ring, b: Ring): number {
  if (a.length < 3 || b.length < 3) return 0;
  const o = a[0]!;
  return scoped((keep) => {
    const pa = keep(kernel.Manifold.extrude([ccw(a, o)], 1));
    const pb = keep(kernel.Manifold.extrude([ccw(b, o)], 1));
    return keep(pa.intersect(pb)).volume();
  });
}

/**
 * Whether nothing is over a room: no roof (16.5) whose highest point is a metre or more above its
 * floor, no room of a higher level and no slab whose underside is, over half of it or more in plan —
 * a roof's overhang along a deck's edge does not cover the deck.
 */
export function openToSky(kernel: Kernel, doc: FloorspecDocument, derived: Derived, id: string): boolean {
  const room = get(doc.rooms, id);
  const poly = derived.rooms[id];
  if (room === undefined || poly === undefined) return true;
  const L = get(doc.levels, room.level);
  const floor = derived.floors?.[id]?.top ?? L?.elevation ?? 0;
  const above = floor + OVER;
  const half = Math.abs(area2(poly.outer)) / 4;
  const covers = (outline: Ring): boolean => half > 0 && shared(kernel, poly.outer, outline) >= half;
  for (const rid of Object.keys(derived.roofs ?? {}).sort()) {
    const r = derived.roofs![rid]!;
    if (Math.max(r.eave, r.surface?.high ?? r.eave) >= above && covers(r.outline)) return false;
  }
  for (const sid of Object.keys(derived.slabs ?? {}).sort()) {
    const s = derived.slabs![sid]!;
    if (s.bottom >= above && covers(s.outline)) return false;
  }
  const elevation = L?.elevation ?? 0;
  for (const other of Object.keys(derived.rooms).sort()) {
    const r = get(doc.rooms, other);
    const M = r === undefined ? undefined : get(doc.levels, r.level);
    if (other === id || M === undefined || M.elevation <= elevation) continue;
    const top = derived.floors?.[other]?.bottom ?? M.elevation;
    if (Math.max(top, M.elevation) >= above && covers(derived.rooms[other]!.outer)) return false;
  }
  return true;
}

/**
 * How far above the ceiling below a floor's solid stops (FLR-T-12.32): 1/16 in, in base units. A
 * ceiling and the underside of the floor over it then never share a plane, in any renderer: the
 * headless raster's bias and the editor's polygon offset draw a ceiling over a floor's underside
 * anyway, but the path tracer has neither, and a ray would meet the two at the same distance.
 */
export const PLENUM_GAP = 2032;

/** How far inside a floor's edge a room below must reach to be under it: 150 mm, in metres. */
const UNDER_INSET = 0.15;
/** The least plan area, in square metres, past that inset, that counts as under: a square centimetre. */
const UNDER_AREA = 1e-4;

/** A room polygon as a cross-section in metres (outer ring counter-clockwise, holes clockwise). */
function sectionOf(kernel: Kernel, outer: Ring, holes: readonly Ring[]): CrossSection {
  const m = (r: Ring, ccwise: boolean): [number, number][] => {
    const pts = r.map((p): [number, number] => [p[0] / UNITS_PER_METRE, p[1] / UNITS_PER_METRE]);
    return area2(r) < 0 === ccwise ? pts.reverse() : pts;
  };
  return new kernel.CrossSection([m(outer, true), ...holes.map((h) => m(h, false))], 'Positive');
}

/**
 * Where each floor that declares no thickness (15.1), on a level with a level below, is drawn down
 * to (FLR-T-12.32), by room ID. Its bottom is PLENUM_GAP above the higher of:
 *
 * - the level below's ceiling line — its elevation plus its `ceilingHeight`, else its `height` (the
 *   ceiling a room of it has unless the room says otherwise); the level below is the one of the
 *   highest elevation under the floor's level's;
 * - the highest point (`high`, 15.2–15.4) of the ceiling of any room of a lower level that is under
 *   the floor and lower than the floor's top.
 *
 * So the solid never reaches into a room below it: a room whose ceiling is higher than its level's
 * line raises it, one whose ceiling is lower sees its own ceiling with the solid out of sight above
 * it, and a double-height room — whose ceiling is at or above the floor's top: the great room under a
 * bridge — does not count, so a bridge over it is as deep as the level below's ceiling line. Where
 * that leaves no depth (the bottom at or above the top) the bottom is the top: a surface facing both
 * ways.
 *
 * A room is under the floor when the floor's polygon, inset by UNDER_INSET, and the room's share
 * more than UNDER_AREA: a sliver along a wall, where the two levels' walls do not stack exactly, is
 * not under it. Of the rooms under it, the one it covers most (the first by ID on a tie) is the
 * room whose ceiling its underside is (`room`): its ceiling finish, else its function's ceiling.
 *
 * A floor with a thickness (its own or its level's) keeps it, and the floors of the lowest level are
 * surfaces facing up, as before. None of this is derived: the standard's floor (15.1) is unchanged.
 */
export function plenumsOf(kernel: Kernel, doc: FloorspecDocument, derived: Derived): Map<string, Plenum> {
  const out = new Map<string, Plenum>();
  const floors = derived.floors;
  if (floors === undefined) return out;
  const levels = Object.keys(doc.levels ?? {})
    .sort()
    .map((id) => get(doc.levels, id)!);
  const ids = Object.keys(derived.rooms)
    .sort()
    .filter((id) => get(doc.rooms, id) !== undefined && derived.rooms[id]!.outer.length >= 3);
  const boxes = new Map(
    ids.map((id) => {
      const o = derived.rooms[id]!.outer;
      const xs = o.map((p) => p[0]);
      const ys = o.map((p) => p[1]);
      return [id, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as const];
    }),
  );
  return scoped((keep) => {
    const sections = new Map<string, CrossSection>();
    const section = (id: string): CrossSection => {
      let s = sections.get(id);
      if (s === undefined) sections.set(id, (s = keep(sectionOf(kernel, derived.rooms[id]!.outer, derived.rooms[id]!.holes))));
      return s;
    };
    for (const id of ids) {
      const room = get(doc.rooms, id)!;
      const fl = floors[id];
      const L = get(doc.levels, room.level);
      if (fl === undefined || L === undefined || fl.top > fl.bottom) continue;
      // The level below: the highest elevation under this level's; its ceiling line.
      let below: { elevation: number; line: number } | undefined;
      for (const M of levels) {
        if (M.elevation >= L.elevation) continue;
        const line = M.elevation + (M.ceilingHeight ?? M.height);
        if (below === undefined || M.elevation > below.elevation || (M.elevation === below.elevation && line > below.line)) below = { elevation: M.elevation, line };
      }
      if (below === undefined) continue;
      let base = below.line;
      let over: { id: string; area: number } | undefined;
      const [ax0, ay0, ax1, ay1] = boxes.get(id)!;
      let inset: CrossSection | undefined;
      for (const other of ids) {
        const r = get(doc.rooms, other)!;
        const M = get(doc.levels, r.level);
        if (M === undefined || M.elevation >= L.elevation) continue;
        const [bx0, by0, bx1, by1] = boxes.get(other)!;
        if (bx0 >= ax1 || bx1 <= ax0 || by0 >= ay1 || by1 <= ay0) continue;
        inset ??= keep(section(id).offset(-UNDER_INSET, 'Miter', 2));
        const shared = keep(inset.intersect(section(other))).area();
        if (!(shared > UNDER_AREA)) continue;
        if (over === undefined || shared > over.area) over = { id: other, area: shared };
        const high = derived.ceilings?.[other]?.high;
        if (high !== undefined && high < fl.top && high > base) base = high;
      }
      out.set(id, { bottom: Math.min(base + PLENUM_GAP, fl.top), ...(over === undefined ? {} : { room: over.id }) });
    }
    return out;
  });
}

/**
 * A vaulted ceiling: the room polygon triangulated in plan, every triangle the ridge line crosses
 * split along it, every vertex lifted to the vault, facing down. A point where an edge crosses the
 * ridge line is at the ridge's elevation, E + h, exactly; its plan position is rational, kept as
 * the nearest double (it is no normative value, and never an extreme of the box: x and y extremes
 * are the outer ring's, and E + h is the ridge's).
 */
function vault(kernel: Kernel, b: MeshBuilder, rings: readonly Ring[], c: VaultedCeiling, base: bigint): void {
  const o = rings[0]![0]!;
  const pts = rings.flat();
  const tris = kernel.triangulate(rings.map((r) => r.map((p): [number, number] => [p[0] - o[0], p[1] - o[1]])));
  const both = (c.slopes ?? 'both') === 'both';
  const lift = (p: P2): P3 => [p[0], p[1], vaultZ(base, c, p)];
  const ridgeZ = Number(base);
  const crossings = new Map<string, P3>();
  /** Where the edge p–q crosses the ridge line: p + (q − p) · c(p) / (c(p) − c(q)), cached per edge. */
  const crossing = (p: P2, q: P2, cp: bigint, cq: bigint): P3 => {
    const key = p[0] < q[0] || (p[0] === q[0] && p[1] < q[1]) ? `${p[0]},${p[1]}|${q[0]},${q[1]}` : `${q[0]},${q[1]}|${p[0]},${p[1]}`;
    let x = crossings.get(key);
    if (!x) {
      const t = Number(cp) / Number(cp - cq);
      x = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, ridgeZ];
      crossings.set(key, x);
    }
    return x;
  };
  // A triangle facing down is clockwise seen from above: (a, c, b) of the counter-clockwise (a, b, c).
  const down = (ps: P3[]): void => {
    const ids = ps.map((p) => b.vertex(p));
    for (let i = 1; i + 1 < ids.length; i++) b.tri(ids[0]!, ids[i + 1]!, ids[i]!);
  };
  for (const [ia, ib, ic] of tris) {
    const tri = [pts[ia]!, pts[ib]!, pts[ic]!];
    const cs = tri.map((p) => cross(c, p));
    if (!both || cs.every((x) => x >= 0n) || cs.every((x) => x <= 0n)) {
      down(tri.map(lift));
      continue;
    }
    // Clip the triangle into its part on each side of the ridge line; vertices on the line belong to both.
    for (const side of [1n, -1n]) {
      const poly: P3[] = [];
      for (let i = 0; i < 3; i++) {
        const p = tri[i]!;
        const q = tri[(i + 1) % 3]!;
        const cp = cs[i]! * side;
        const cq = cs[(i + 1) % 3]! * side;
        if (cp >= 0n) poly.push(lift(p));
        if ((cp > 0n && cq < 0n) || (cp < 0n && cq > 0n)) poly.push(crossing(p, q, cs[i]!, cs[(i + 1) % 3]!));
      }
      if (poly.length >= 3) down(poly);
    }
  }
}
