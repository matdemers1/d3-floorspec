/**
 * Floors, ceilings and slabs (Core 0.3, chapter 15), from the derived room polygons, floors,
 * ceilings and slabs.
 *
 * - A floor with a thickness is a solid prism of its room polygon from its bottom to its top; a
 *   floor with none ("not declared", 15.1) is a surface facing up at its top.
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
import { scoped, type Kernel } from './kernel.js';
import type { RawPart } from './part.js';

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

export function roomParts(kernel: Kernel, doc: FloorspecDocument, derived: Derived, want: (kind: RawPart['kind']) => boolean): RawPart[] {
  const out: RawPart[] = [];
  for (const id of Object.keys(derived.rooms).sort()) {
    const room = get(doc.rooms, id);
    const poly = derived.rooms[id]!;
    if (!room) continue;
    const rings: Ring[] = [poly.outer, ...poly.holes];
    const fl = derived.floors?.[id];
    if (fl && want('floor')) {
      const b = new MeshBuilder(kernel);
      const closed = fl.top > fl.bottom;
      if (closed) b.prism(rings, fl.bottom, fl.top);
      else b.sheet(rings, fl.top, 'up');
      out.push({ kind: 'floor', id, level: room.level, closed, ...(closed ? {} : { facing: 'up' as const }), exact: b });
    }
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
