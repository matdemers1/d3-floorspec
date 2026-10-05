/** Circulation (Core 0.2, chapter 14) through the API, on small hand-built plans. The conformance suite is the oracle; these pin the API shape and a few properties the suite cannot. */
import { describe, expect, it } from 'vitest';
import { analyseCirculation, check, derive, evaluate, validate } from '../src/index.js';
import { codes, doc } from './doc.js';

const DOOR = { kind: 'doorType', width: 914400, height: 2032000 };

/**
 * A row of n rooms, each 3 m × 4 m, west to east: junctions S0…Sn on the south wall, N0…Nn on the
 * north; walls wBk (south of room k), wTk (north), wVk (west of room k; wVn the east wall). Doors are
 * named by their wall without the w.
 */
function row(rooms: [id: string, fn: string][], doors: string[], order: 'forward' | 'reverse' = 'forward'): Record<string, unknown> {
  const n = rooms.length;
  const W = 3_840_000;
  const H = 5_120_000;
  const junctions: Record<string, [number, number]> = {};
  const walls: Record<string, { start: string; end: string }> = {};
  for (let k = 0; k <= n; k++) {
    junctions[`S${k}`] = [k * W, 0];
    junctions[`N${k}`] = [k * W, H];
    walls[`wV${k}`] = { start: `S${k}`, end: `N${k}` };
    if (k < n) {
      walls[`wB${k}`] = { start: `S${k}`, end: `S${k + 1}` };
      walls[`wT${k}`] = { start: `N${k}`, end: `N${k + 1}` };
    }
  }
  const roomSpec: Record<string, Record<string, unknown>> = {};
  rooms.forEach(([id, fn], k) => (roomSpec[id] = { anchor: [k * W + W / 2, H / 2], function: fn }));
  const openings: Record<string, Record<string, unknown>> = {};
  for (const w of doors) openings[`D${w}`] = { wall: `w${w}`, offset: 1_000_000, fill: 'D' };
  const d: Record<string, unknown> = { ...doc({ junctions, walls, rooms: roomSpec, openings }), floorspec: '0.2', ...(doors.length && { types: { D: DOOR } }) };
  if (order === 'reverse') for (const c of ['junctions', 'walls', 'rooms', 'openings'] as const) d[c] = Object.fromEntries(Object.entries(d[c] as object).reverse());
  return d;
}

describe('circulation (14)', () => {
  it('derives entry, reachable and throughSleeping for every room', () => {
    const d = derive(row([['LIV', 'living'], ['BED1', 'sleeping'], ['BED2', 'sleeping'], ['BATH', 'bath']], ['B0', 'V1', 'V2', 'V3']));
    expect(d.circulation).toEqual({
      LIV: { entry: true, reachable: true },
      BED1: { entry: false, reachable: true, throughSleeping: false },
      BED2: { entry: false, reachable: true, throughSleeping: true },
      BATH: { entry: false, reachable: true },
    });
  });

  it('reports a bedroom reached through another, and nothing for the bath beyond it, as warnings', () => {
    const r = validate(row([['LIV', 'living'], ['BED1', 'sleeping'], ['BED2', 'sleeping'], ['BATH', 'bath']], ['B0', 'V1', 'V2', 'V3']));
    expect(r.valid).toBe(true);
    expect(codes(r)).toEqual(['FS-LINT-013 BED2']);
    expect(r.diagnostics.every((x) => x.severity === 'warning')).toBe(true);
  });

  it('reports a building with doors and no entry once, not each room', () => {
    const r = validate(row([['A', 'living'], ['B', 'office'], ['C', 'sleeping']], ['V1']));
    expect(codes(r)).toEqual(['FS-LINT-014 B1']);
  });

  it('says nothing of a plan with no door yet', () => {
    const r = check(row([['A', 'living'], ['B', 'office']], []));
    expect(codes(r)).toEqual([]);
    expect(r.derived!.circulation).toEqual({ A: { entry: false, reachable: false }, B: { entry: false, reachable: false } });
  });

  it('a window is not a way in', () => {
    const d = row([['A', 'living'], ['B', 'office']], ['B0']);
    (d.types as Record<string, unknown>).WIN = { kind: 'windowType', width: 914400, height: 914400, sill: 914400 };
    (d.openings as Record<string, unknown>).NV1 = { wall: 'wV1', offset: 1_000_000, fill: 'WIN' };
    expect(codes(validate(d))).toEqual(['FS-LINT-012 B']);
  });

  it('does not depend on the order a document lists its elements', () => {
    const rooms: [string, string][] = [['LIV', 'living'], ['BED1', 'sleeping'], ['BED2', 'sleeping'], ['BATH', 'bath']];
    const a = check(row(rooms, ['B0', 'V1', 'V2', 'V3']));
    const b = check(row(rooms, ['B0', 'V1', 'V2', 'V3'], 'reverse'));
    expect(b.derived!.circulation).toEqual(a.derived!.circulation);
    expect(codes(b)).toEqual(codes(a));
  });

  it('exposes each building: evaluated, its rooms and entries', () => {
    const ev = evaluate(row([['LIV', 'living'], ['BED', 'sleeping']], ['B0', 'V1']));
    const c = analyseCirculation(ev.document!, ev.analysis!);
    expect(c.buildings.get('B1')).toEqual({ evaluated: true, rooms: ['BED', 'LIV'], entries: ['LIV'] });
  });
});
