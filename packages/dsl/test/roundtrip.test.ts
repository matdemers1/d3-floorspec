/**
 * Round trips (FLR-T-10.5): random rectilinear plans written in the DSL compile to exactly the rooms
 * they describe, and document → DSL → document keeps every derived room, area and opening; so do the
 * layout solver's candidates, a second, independent writer of rectilinear plans.
 */
import { describe, expect, test } from 'vitest';
import { apply } from '@floorspec/ops';
import { solve } from '@floorspec/layout-solver';
import { toDsl } from '../src/index.js';
import { built, prng, summarize } from './helpers.js';

const FT = 390144;
const IN = 32512;
const HALF_FT = 6 * IN;

interface R {
  name: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A random slicing floorplan on a 6-inch grid, with some rooms left out (notches, courtyards, islands). */
function randomRooms(rand: () => number): R[] {
  const g = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
  let leaves: Omit<R, 'name'>[] = [{ x0: 0, y0: 0, x1: g(16, 70), y1: g(16, 60) }];
  const splits = g(1, 9);
  for (let i = 0; i < splits; i++) {
    const idx = Math.floor(rand() * leaves.length);
    const r = leaves[idx]!;
    const w = r.x1 - r.x0;
    const h = r.y1 - r.y0;
    const vertical = w >= h ? rand() < 0.75 : rand() < 0.25;
    const span = vertical ? w : h;
    if (span < 12) continue; // keep every room at least 6' across
    const cut = g(6, span - 6);
    leaves.splice(idx, 1, vertical ? { ...r, x1: r.x0 + cut } : { ...r, y1: r.y0 + cut }, vertical ? { ...r, x0: r.x0 + cut } : { ...r, y0: r.y0 + cut });
  }
  if (leaves.length > 2) leaves = leaves.filter((_, i) => i === 0 || rand() > 0.15);
  return leaves.map((r, i) => ({ name: `r${i + 1}`, ...r }));
}

const touching = (a: R, b: R): { axis: 'h' | 'v'; lo: number; hi: number } | undefined => {
  if (a.x1 === b.x0 || b.x1 === a.x0) {
    const lo = Math.max(a.y0, b.y0);
    const hi = Math.min(a.y1, b.y1);
    return hi > lo ? { axis: 'v', lo, hi } : undefined;
  }
  if (a.y1 === b.y0 || b.y1 === a.y0) {
    const lo = Math.max(a.x0, b.x0);
    const hi = Math.min(a.x1, b.x1);
    return hi > lo ? { axis: 'h', lo, hi } : undefined;
  }
  return undefined;
};

/** The DSL for rooms: placed `at` or, where an edge meets exactly, by a relation; some boundaries open, doors and windows. */
function writeDsl(rooms: R[], rand: () => number, lines: string[] = ['wall exterior 6"', 'wall interior 6"']): { text: string; open: Set<string> } {
  const ft = (n: number): string => `${n / 2}'`;
  rooms.forEach((r, i) => {
    const prev = rooms.slice(0, i);
    const east = prev.find((p) => p.x1 === r.x0 && p.y0 === r.y0);
    const north = prev.find((p) => p.y1 === r.y0 && p.x1 === r.x1);
    const where = i === 0 && r.x0 === 0 && r.y0 === 0 && rand() < 0.5 ? '' : east ? ` east-of ${east.name}` : north ? ` north-of ${north.name} aligned east` : ` at ${ft(r.x0)}, ${ft(r.y0)}`;
    lines.push(`${r.name} ${ft(r.x1 - r.x0)}x${ft(r.y1 - r.y0)}${where}`);
  });
  const open = new Set<string>();
  for (let i = 0; i < rooms.length; i++)
    for (let j = i + 1; j < rooms.length; j++) {
      const t = touching(rooms[i]!, rooms[j]!);
      if (!t) continue;
      const roll = rand();
      if (roll < 0.25) {
        lines.push(`open ${rooms[i]!.name}-${rooms[j]!.name}`);
        open.add(rooms[i]!.name).add(rooms[j]!.name);
      } else if (roll < 0.75 && t.hi - t.lo >= 6) lines.push(`door ${rooms[i]!.name}-${rooms[j]!.name} 30" hinge ${t.axis === 'h' ? 'east' : 'north'} swing into ${rooms[rand() < 0.5 ? i : j]!.name}`);
    }
  // A window on each side of a room that nothing else touches.
  for (const r of rooms)
    for (const side of ['north', 'south', 'east', 'west'] as const) {
      const others = rooms.filter((o) => o !== r);
      const free =
        side === 'north'
          ? !others.some((o) => o.y0 === r.y1 && o.x0 < r.x1 && r.x0 < o.x1)
          : side === 'south'
            ? !others.some((o) => o.y1 === r.y0 && o.x0 < r.x1 && r.x0 < o.x1)
            : side === 'east'
              ? !others.some((o) => o.x0 === r.x1 && o.y0 < r.y1 && r.y0 < o.y1)
              : !others.some((o) => o.x1 === r.x0 && o.y0 < r.y1 && r.y0 < o.y1);
      const len = side === 'north' || side === 'south' ? r.x1 - r.x0 : r.y1 - r.y0;
      if (free && len >= 8 && rand() < 0.5) lines.push(`window ${r.name} ${side} 3'x4' sill 3'`);
    }
  return { text: lines.join('\n'), open };
}

describe('random rectilinear plans', () => {
  const CASES = 150;
  for (let seed = 1; seed <= CASES; seed++)
    test(`seed ${seed}: DSL → document has exactly the rooms written, and document → DSL → document is the same plan`, () => {
      const rand = prng(seed);
      // Every third plan has an upper level with a plan of its own.
      const ground = randomRooms(rand);
      const upper = seed % 3 === 0 ? randomRooms(rand).map((r) => ({ ...r, name: `u${r.name}` })) : [];
      const first = writeDsl(ground, rand, ['wall exterior 6"', 'wall interior 6"', "level ground at 0 height 9'"]);
      const second = upper.length > 0 ? writeDsl(upper, rand, ["level upper above ground height 8'"]) : { text: '', open: new Set<string>() };
      const rooms = [...ground, ...upper];
      const text = `${first.text}\n${second.text}`;
      const open = new Set([...first.open, ...second.open]);
      const b = built(text);
      const s = summarize(b.document);
      expect(Object.keys(s.rooms).sort()).toEqual(rooms.map((r) => r.name[0]!.toUpperCase() + r.name.slice(1)).sort());
      // Walls of one thickness t, centred: a room with no open side keeps (w − t)(h − t), exactly.
      const t = 6 * IN;
      for (const r of rooms) {
        if (open.has(r.name)) continue;
        const area = (BigInt((r.x1 - r.x0) * HALF_FT - t) * BigInt((r.y1 - r.y0) * HALF_FT - t)).toString();
        expect(s.rooms[r.name[0]!.toUpperCase() + r.name.slice(1)]!.area, `${r.name} in\n${text}`).toBe(area);
      }
      // The round trip.
      const dsl = toDsl(b.document);
      const again = built(dsl);
      expect(summarize(again.document)).toEqual(s);
      expect(toDsl(again.document)).toBe(dsl);
    });
});

describe('the layout solver’s candidates', () => {
  const sf = (n: number): number => n * 152212340736;
  const house = (program: object): Record<string, unknown> => ({
    floorspec: '0.2',
    project: { name: 'Solved' },
    buildings: { B1: { name: 'House' } },
    levels: { L1: { building: 'B1', elevation: 0, height: 9 * FT, name: 'Ground floor' } },
    program,
  });
  const CABIN = {
    items: {
      GRT: { function: 'living', name: 'Great room', targetArea: sf(260), minArea: sf(200) },
      KIT: { function: 'kitchen', name: 'Kitchen', targetArea: sf(110), minArea: sf(80) },
      BED: { function: 'sleeping', name: 'Bedroom', targetArea: sf(130), minArea: sf(100) },
      BTH: { function: 'bath', name: 'Bath', targetArea: sf(45), minArea: sf(35) },
    },
    adjacency: [
      { a: 'KIT', b: 'GRT', kind: 'required' },
      { a: 'BED', b: 'BTH', kind: 'preferred' },
      { a: 'KIT', b: 'BED', kind: 'forbidden' },
    ],
  };
  const RANCH = {
    items: {
      LIV: { function: 'living', name: 'Living room', targetArea: sf(300) },
      KIT: { function: 'kitchen', name: 'Kitchen', targetArea: sf(170) },
      DIN: { function: 'dining', name: 'Dining', targetArea: sf(130) },
      PBR: { function: 'sleeping', name: 'Primary bedroom', targetArea: sf(190) },
      PBA: { function: 'bath', name: 'Primary bath', targetArea: sf(75) },
      BED: { function: 'sleeping', name: 'Bedroom', count: 2, targetArea: sf(130) },
      BTH: { function: 'bath', name: 'Hall bath', targetArea: sf(50) },
      GAR: { function: 'garage', name: 'Garage', targetArea: sf(460) },
    },
    adjacency: [
      { a: 'KIT', b: 'DIN', kind: 'required' },
      { a: 'PBR', b: 'PBA', kind: 'required' },
      { a: 'GAR', b: 'BED', kind: 'forbidden' },
    ],
  };
  for (const [name, program] of [
    ['cabin', CABIN],
    ['ranch', RANCH],
  ] as const)
    test(`${name}: every candidate decompiles and compiles back to the same rooms, openings and program`, () => {
      const doc = house(program);
      const candidates = solve(doc, { count: 3 });
      expect(candidates.length).toBeGreaterThan(0);
      for (const c of candidates) {
        const r = apply(doc, { batch: c.batch });
        if (r.status !== 'committed') expect.fail(JSON.stringify(r.diagnostics.slice(0, 3)));
        const dsl = toDsl(r.document);
        const again = built(dsl);
        expect(summarize(again.document), dsl).toEqual(summarize(r.document));
      }
    });
});
