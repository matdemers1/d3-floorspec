/** Chapter 6: measures of openings, on small hand-made documents (beyond the conformance suite). */
import { describe, expect, it } from 'vitest';
import { doc, FT, IN, measures, opening, row, type Spec } from './docs.js';

const W = 12 * FT;
const H = 10 * FT;

// R1 and R2 in a row. O1: a window in R1's north wall (outside); O2: a door in the shared wall;
// O3: an empty opening, its own size, in R2's east wall (outside); O4: a window with its own width.
const spec = (extra: Partial<Spec> = {}): Spec =>
  row(W, H, {
    openings: {
      O1: { wall: 'W2', offset: 4 * FT, fill: 'WIN' },
      O2: { wall: 'W7', offset: 3 * FT, fill: 'DOOR' },
      O3: { wall: 'W4', offset: 2 * FT, width: 6 * FT, height: 80 * IN },
      O4: { wall: 'W6', offset: 2 * FT, fill: 'WIN', width: 2 * FT, sill: 3 * FT },
    },
    ...extra,
  });

describe('openingKind (6.1)', () => {
  it('is door, window or empty, by fill', () => {
    const r = measures(doc(spec()), ['O1', 'O2', 'O3'].map((id) => ({ target: opening(id), measure: 'openingKind' })));
    expect(r.map((x) => x.value)).toEqual(['window', 'door', 'empty']);
  });
});

describe('size as drawn (6.2)', () => {
  it('is the effective width and height — the opening’s own, else its fill type’s', () => {
    const r = measures(doc(spec()), [
      { target: opening('O1'), measure: 'openingWidth' },
      { target: opening('O1'), measure: 'openingHeight' },
      { target: opening('O3'), measure: 'openingWidth' },
      { target: opening('O3'), measure: 'openingHeight' },
      { target: opening('O4'), measure: 'openingWidth' },
    ]);
    expect(r.map((x) => x.value)).toEqual([3 * FT, 4 * FT, 6 * FT, 80 * IN, 2 * FT]);
    expect(r[0]!.display).toBe("3' 0\"");
    expect(r[3]!.display).toBe("6' 8\"");
  });

  it('openingArea is width × height exactly, an area', () => {
    const [a1, a3] = measures(doc(spec()), [
      { target: opening('O1'), measure: 'openingArea' },
      { target: opening('O3'), measure: 'openingArea' },
    ]);
    // 3' × 4' is 12 sq ft: 12 × 152,212,340,736 square base units.
    expect(a1).toEqual({ type: 'area', value: String(12n * 152212340736n), display: '12.00 sq ft' });
    expect(a3!.value).toBe(String(BigInt(6 * FT) * BigInt(80 * IN)));
    expect(a3!.display).toBe('40.00 sq ft');
  });
});

describe('heights above the floor (6.3)', () => {
  it('are the sill and head elevations less the floor of the level', () => {
    const r = measures(doc(spec()), [
      { target: opening('O1'), measure: 'openingSillHeight' },
      { target: opening('O1'), measure: 'openingHeadHeight' },
      { target: opening('O2'), measure: 'openingSillHeight' },
      { target: opening('O4'), measure: 'openingSillHeight' },
    ]);
    expect(r.map((x) => x.value)).toEqual([2 * FT, 6 * FT, 0, 3 * FT]);
  });

  it('see a level that is not at zero, and a wall whose base is raised', () => {
    const s = spec({ levels: { L1: { building: 'B1', elevation: 9 * FT, height: 3456000 } } });
    s.walls = { ...s.walls, W2: { start: 'J2', end: 'J3', base: { offset: FT } } };
    const r = measures(doc(s), [
      { target: opening('O1'), measure: 'openingSillHeight' },
      { target: opening('O1'), measure: 'openingHeadHeight' },
      { target: opening('O2'), measure: 'openingSillHeight' },
    ]);
    // The raised wall lifts its window by a foot; the level's own elevation is the floor.
    expect(r.map((x) => x.value)).toEqual([3 * FT, 7 * FT, 0]);
  });
});

describe('openingToOutside (6.4)', () => {
  it('is whether the opening’s wall faces the outside', () => {
    const r = measures(doc(spec()), ['O1', 'O2', 'O3', 'O4'].map((id) => ({ target: opening(id), measure: 'openingToOutside' })));
    expect(r.map((x) => x.value)).toEqual([true, false, true, true]);
  });
});

describe('operation and net clear opening (6.1, 6.5) — as declared, never computed', () => {
  // A Core 0.3 document: the window type declares a casement with a clear opening and an area; the
  // door type a swing with a clear width and height; O4 overrides the window's clear opening whole,
  // with no area; O3, empty, declares none.
  const v03 = (): Record<string, unknown> => {
    const d = doc(spec());
    const types = d.types as Record<string, Record<string, unknown>>;
    types.WIN = { ...types.WIN, operation: 'casement', clearOpening: { width: 30 * IN, height: 44 * IN, area: 1200 * IN * IN } };
    types.DOOR = { ...types.DOOR, operation: 'swing', clearOpening: { width: 32 * IN, height: 79 * IN } };
    const openings = d.openings as Record<string, Record<string, unknown>>;
    openings.O4 = { ...openings.O4, clearOpening: { width: 20 * IN, height: 44 * IN } };
    return { ...d, floorspec: '0.3' };
  };
  const call = (id: string, measure: string) => ({ target: opening(id), measure });

  it('reads the fill type operation, with no value for an empty opening', () => {
    const r = measures(v03(), ['O1', 'O2', 'O3'].map((id) => call(id, 'openingOperation')));
    expect(r.map((x) => x.value)).toEqual(['casement', 'swing', null]);
  });

  it('reads the effective clear opening — the opening’s own, resolved whole, else its type’s', () => {
    const r = measures(v03(), [
      call('O1', 'openingNetClearWidth'),
      call('O1', 'openingNetClearHeight'),
      call('O1', 'openingNetClearArea'),
      call('O4', 'openingNetClearWidth'),
      call('O4', 'openingNetClearArea'),
      call('O3', 'openingNetClearWidth'),
    ]);
    expect(r.map((x) => x.value)).toEqual([30 * IN, 44 * IN, String(1200 * IN * IN), 20 * IN, null, null]); // an area is a decimal string (4.2)
    expect(r[4]!.display).toBe('not stated');
  });

  it('gives doorClearWidth for a door only', () => {
    const r = measures(v03(), ['O1', 'O2', 'O3'].map((id) => call(id, 'doorClearWidth')));
    expect(r.map((x) => x.value)).toEqual([null, 32 * IN, null]);
  });

  it('has no value for any of them in a 0.2 document, which declares none', () => {
    const r = measures(doc(spec()), ['openingOperation', 'openingNetClearWidth', 'openingNetClearArea', 'doorClearWidth'].map((m) => call('O2', m)));
    expect(r.map((x) => x.value)).toEqual([null, null, null, null]);
  });
});
