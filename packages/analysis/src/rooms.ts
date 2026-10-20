/**
 * What is over and under each room (FLR-T-16.4), for the room-by-room estimate: the share of a room's
 * ceiling that is under no conditioned room of the level above — and, of that, under which roof — and
 * the share of an upper room's floor that is over no conditioned room of the level below — over an
 * unconditioned room (a garage), or over nothing (a cantilever, a porch).
 *
 * Measured by sampling, deterministically: a 12 × 12 grid over each room polygon's bounding box, the
 * points inside the polygon (Core 6.2's room polygon, outside its holes), each tested against the room
 * polygons above or below and the roofs' plan outlines (Core 16). Good to a few per cent of a room's
 * area, which is far inside the estimate's ±20%.
 */
import type { Derived, FloorspecDocument } from '@floorspec/engine';

type P = readonly [number, number];

/** Is `p` inside the closed ring (even-odd)? */
export function inRing(p: P, ring: readonly P[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

interface Poly {
  readonly outer: readonly P[];
  readonly holes: readonly (readonly P[])[];
}

const inPoly = (p: P, poly: Poly): boolean => inRing(p, poly.outer) && !poly.holes.some((h) => inRing(p, h));

const GRID = 12;

/** The grid points inside a room polygon. */
export function samplesOf(poly: Poly): P[] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of poly.outer) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const out: P[] = [];
  for (let i = 0; i < GRID; i++)
    for (let j = 0; j < GRID; j++) {
      const p: P = [x0 + ((i + 0.5) / GRID) * (x1 - x0), y0 + ((j + 0.5) / GRID) * (y1 - y0)];
      if (inPoly(p, poly)) out.push(p);
    }
  return out;
}

/** What a share of a room's ceiling or floor faces. */
export interface Exposed {
  /** 0–1 of the room's area. */
  readonly share: number;
  /** `outside`, or `unconditioned` (a garage above or below). */
  readonly toward: 'outside' | 'unconditioned';
  /** The roof over it, for a ceiling: the lowest roof at or above the room's level whose outline covers it. */
  readonly roof?: string;
}

export interface RoomCover {
  readonly room: string;
  /** The room is on the lowest level of its building with a conditioned room: its floor is on the ground. */
  readonly onGround: boolean;
  readonly ceiling: Exposed[];
  readonly floor: Exposed[];
}

/**
 * Every conditioned room's cover: `conditioned(id)` says which rooms are; rooms whose function is
 * `exterior` (a deck, a porch) count as outside, and other unconditioned rooms as unconditioned.
 */
export function roomCovers(doc: FloorspecDocument, derived: Derived, conditioned: (id: string) => boolean): RoomCover[] {
  const rooms = doc.rooms ?? {};
  const levels = doc.levels ?? {};
  const polys = new Map<string, Poly>();
  for (const id of Object.keys(rooms)) {
    const d = derived.rooms[id];
    if (d) polys.set(id, { outer: d.outer, holes: d.holes });
  }
  const levelOf = (id: string) => rooms[id]!.level;
  // Each building's levels, low to high.
  const byBuilding = new Map<string, string[]>();
  for (const id of Object.keys(levels).sort()) {
    const b = levels[id]!.building;
    byBuilding.set(b, [...(byBuilding.get(b) ?? []), id]);
  }
  for (const ls of byBuilding.values()) ls.sort((a, b) => levels[a]!.elevation - levels[b]!.elevation || (a < b ? -1 : 1));
  const onLevel = (lid: string) => [...polys.keys()].filter((r) => levelOf(r) === lid).sort();
  const lowest = new Map<string, string | undefined>();
  for (const [b, ls] of byBuilding) lowest.set(b, ls.find((l) => onLevel(l).some(conditioned)));
  // Roofs, by the elevation of the level each stands on.
  const roofs = Object.entries((doc.roofs ?? {}) as Record<string, { level: string }>)
    .flatMap(([id, r]) => {
      const d = derived.roofs?.[id];
      return d ? [{ id, elevation: levels[r.level]?.elevation ?? 0, outline: d.outline }] : [];
    })
    .sort((a, b) => a.elevation - b.elevation || (a.id < b.id ? -1 : 1));

  const out: RoomCover[] = [];
  for (const id of [...polys.keys()].sort()) {
    if (!conditioned(id)) continue;
    const lid = levelOf(id);
    const level = levels[lid]!;
    const ls = byBuilding.get(level.building) ?? [lid];
    const i = ls.indexOf(lid);
    const above = i + 1 < ls.length ? ls[i + 1] : undefined;
    const below = i > 0 ? ls[i - 1] : undefined;
    const pts = samplesOf(polys.get(id)!);
    const n = pts.length;
    const whereOn = (other: string | undefined, p: P): 'conditioned' | 'unconditioned' | 'outside' => {
      if (other === undefined) return 'outside';
      for (const r of onLevel(other)) {
        if (!inPoly(p, polys.get(r)!)) continue;
        if (conditioned(r)) return 'conditioned';
        return rooms[r]!.function === 'exterior' ? 'outside' : 'unconditioned';
      }
      return 'outside';
    };
    const ceiling = new Map<string, number>();
    const floor = new Map<string, number>();
    const onGround = lowest.get(level.building) === lid;
    for (const p of pts) {
      const up = whereOn(above, p);
      if (up !== 'conditioned') {
        const roof = roofs.find((r) => r.elevation >= level.elevation && inRing(p, r.outline));
        const key = `${up}|${roof?.id ?? ''}`;
        ceiling.set(key, (ceiling.get(key) ?? 0) + 1);
      }
      if (!onGround) {
        const down = whereOn(below, p);
        if (down !== 'conditioned') floor.set(down, (floor.get(down) ?? 0) + 1);
      }
    }
    const asExposed = (m: Map<string, number>): Exposed[] =>
      [...m]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, c]) => {
          const [toward, roof] = k.split('|') as ['outside' | 'unconditioned', string | undefined];
          return { share: n === 0 ? 0 : c / n, toward, ...(roof ? { roof } : {}) };
        });
    out.push({ room: id, onGround, ceiling: asExposed(ceiling), floor: asExposed(floor) });
  }
  return out;
}
