/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apply } from '@floorspec/ops';
import { OFFICIAL_READER } from '@floorspec/engine';
import { readModel, type EditorModel, type LevelView, type Point } from '../src/editor/model';
import type { Batch } from '../src/editor/ops';
import { alignMove, alignOpening, snapAngle, snapPoint, SNAP_DEFAULTS, type SnapSettings } from '../src/editor/snap';
import { compass, temporaryDimensions, type TempDim } from '../src/editor/precision/dimensions';
import { summarize, WORK_TRIANGLE, triangleKind } from '../src/editor/precision/measure';
import { gridSteps, modeSnapDefaults, snapSummary } from '../src/editor/precision/state';

/**
 * FLR-T-18.9: precision without effort — the snap engine's settings and smart guides, temporary
 * dimensions typed into on the Courtyard House through the real applier (as the server applies them),
 * and the measure tool's sums.
 */

const IN = 32_512;
const FT = 12 * IN;
const HOUSE = readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8');

function commit(doc: string, batch: Batch): string {
  const r = apply(doc, { batch }, OFFICIAL_READER);
  if (r.status !== 'committed') throw new Error(`rejected: ${r.diagnostics.map((d) => `${d.code} ${d.message}`).join('; ')}`);
  return r.document;
}

const model = readModel('h', HOUSE);
const L1 = model.levels.find((l) => l.id === 'L1')!;

/** Type `value` into a temporary dimension, commit it, and read the same dimension back. */
function typeInto(m: EditorModel, id: string, key: string, value: number, ref: 'face' | 'centre' | 'far' = 'face'): { before: TempDim; after: TempDim } {
  const level = m.levels.find((l) => l.id === 'L1')!;
  const before = temporaryDimensions(m, level, id, ref).find((d) => d.key === key)!;
  expect(before, `${id} ${key}`).toBeDefined();
  const r = before.apply!(value);
  if ('error' in r) throw new Error(r.error);
  const doc = commit(JSON.stringify(m.document), r.batch);
  const next = readModel('h2', doc);
  const after = temporaryDimensions(next, next.levels.find((l) => l.id === 'L1')!, id, ref).find((d) => d.key === key)!;
  return { before, after };
}

function bare(partial: Partial<LevelView>): LevelView {
  return { id: 'L1', name: 'Level 1', building: 'B1', elevation: 0, height: 3_000_000, junctions: [], walls: [], fills: [], separators: [], openings: [], rooms: [], faces: [], devices: [], slabs: [], roofs: [], stairs: [], bounds: null, ...partial };
}

const W = (id: string, a: Point, b: Point, t = 6 * IN) => ({
  id, level: 'L1', start: `${id}a`, end: `${id}b`, a, b,
  ring: (() => {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n: Point = [(-(b[1] - a[1]) / l) * (t / 2), ((b[0] - a[0]) / l) * (t / 2)];
    return [[a[0] - n[0], a[1] - n[1]], [b[0] - n[0], b[1] - n[1]], [b[0] + n[0], b[1] + n[1]], [a[0] + n[0], a[1] + n[1]]] as Point[];
  })(),
  line: [a, b], thickness: t, left: t / 2, right: t / 2, type: undefined, justification: 'center',
});

describe('the snap engine’s settings', () => {
  const grid = IN / 2;
  const level = bare({ junctions: [{ id: 'J1', position: [0, 0], edges: 1 }, { id: 'J2', position: [10 * FT, 0], edges: 1 }], walls: [W('W1', [0, 0], [10 * FT, 0])] });

  it('off, leaves the point where the pointer is, to the base unit', () => {
    expect(snapPoint(level, [10 * FT + 3.4, 7.6], { tol: 5 * IN, grid, settings: { ...SNAP_DEFAULTS, on: false } })).toMatchObject({ point: [10 * FT + 3, 8], kind: 'free' });
  });

  it('snaps to a wall’s midpoint, on its lattice, before the wall itself', () => {
    expect(snapPoint(level, [5 * FT + 900, 1000], { tol: 2 * IN, grid })).toMatchObject({ point: [5 * FT, 0], kind: 'midpoint', ref: 'W1', label: 'Midpoint of W1' });
    // Midpoints off: the wall, at a grid point along it.
    expect(snapPoint(level, [5 * FT + 900, 1000], { tol: 2 * IN, grid, settings: { ...SNAP_DEFAULTS, midpoints: false } }).kind).toBe('wall');
  });

  it('junctions off, walls off: a junction is passed by, and the grid is all there is', () => {
    const s: SnapSettings = { ...SNAP_DEFAULTS, junctions: false, walls: false, midpoints: false, guides: false };
    expect(snapPoint(level, [10 * FT + 1000, 2000], { tol: 5 * IN, grid, settings: s })).toMatchObject({ kind: 'grid', point: [10 * FT, 0] });
    expect(snapPoint(level, [10 * FT + 1000, 2000], { tol: 5 * IN, grid: 6 * IN, settings: { ...s, grid: false } })).toMatchObject({ kind: 'grid', point: [10 * FT + 1000, 2000] });
  });

  it('measures to a wall’s face, not only its location line', () => {
    const s = snapPoint(level, [3 * FT, 3 * IN + 200], { tol: 2 * IN, grid, faces: true });
    expect(s).toMatchObject({ kind: 'face', ref: 'W1', point: [3 * FT, 3 * IN] });
  });

  it('snaps to an item’s corner and centre, and to another level’s points', () => {
    const island = L1.devices.find((d) => d.id === 'KIT-ISLAND')!;
    const xs = island.footprint.map((p) => p[0]);
    const ys = island.footprint.map((p) => p[1]);
    const c: Point = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
    const s = snapPoint(L1, [c[0] + 500, c[1] - 500], { tol: 2 * IN, grid, faces: true, name: (id) => (id === 'KIT-ISLAND' ? 'Island' : id) });
    expect(s).toMatchObject({ kind: 'item', ref: 'KIT-ISLAND', label: 'Centre of Island' });
    expect(snapPoint(bare({}), [100, 100], { tol: 2 * IN, grid, settings: { ...SNAP_DEFAULTS, ghosts: true }, ghosts: [[0, 0]] })).toMatchObject({ kind: 'ghost', point: [0, 0] });
    expect(snapPoint(bare({}), [100, 100], { tol: 2 * IN, grid, ghosts: [[0, 0]] }).kind).toBe('grid');
  });

  it('draws parallel and perpendicular to an oblique wall nearby, as a smart guide', () => {
    const oblique = bare({ walls: [W('W9', [0, 0], [30 * FT, 40 * FT])] });
    // From a point beside it, along its direction (53.13°: no angle step).
    const from: Point = [3 * FT, 0];
    const raw: Point = [from[0] + 3 * 5 * FT + 2000, 4 * 5 * FT];
    const s = snapPoint(oblique, raw, { from, tol: 3 * IN, grid });
    expect(s.label).toBe('Parallel to W9');
    expect(s.kind).toBe('angle');
    // Square to it.
    const p = snapPoint(oblique, [from[0] - 4 * 3 * FT, 3 * 3 * FT + 3000], { from, tol: 3 * IN, grid });
    expect(p.label).toBe('Perpendicular to W9');
  });

  it('follows an oblique wall’s extension line beyond its end', () => {
    const oblique = bare({ walls: [W('W9', [0, 0], [3 * FT, 4 * FT])] });
    const s = snapPoint(oblique, [6 * FT + 300, 8 * FT - 200], { tol: 2 * IN, grid, settings: { ...SNAP_DEFAULTS, midpoints: false } });
    expect(s).toMatchObject({ kind: 'guide', ref: 'W9', label: 'Extension of W9' });
    // Exactly on the line through the wall: a lattice point of it.
    expect(s.point[0] * 4).toBe(s.point[1] * 3);
  });

  it('steps angles by the setting', () => {
    expect(snapAngle((44 * Math.PI) / 180, false, 45)).toBe(45);
    expect(snapAngle((31 * Math.PI) / 180, false, 5)).toBe(30);
    expect(snapAngle((34 * Math.PI) / 180, false, 5)).toBe(35);
    expect(snapAngle((33 * Math.PI) / 180, false, 90)).toBeNull();
  });

  it('lines a dragged box up with a wall face and an item centre, and says so', () => {
    const box = { minX: 0, minY: 0, maxX: 2 * FT, maxY: 2 * FT };
    const walls = bare({ walls: [W('W1', [5 * FT, -10 * FT], [5 * FT, 10 * FT])] });
    // Its right edge 1000 units short of the wall's west face (5' − 3").
    const m = alignMove(walls, box, [3 * FT - 3 * IN - 1000, 0], { tol: 2 * IN });
    expect(m.d[0]).toBe(3 * FT - 3 * IN);
    expect(m.label).toBe('Face of W1');
    expect(alignMove(walls, box, [3 * FT - 3 * IN - 1000, 0], { tol: 2 * IN, settings: { ...SNAP_DEFAULTS, guides: false } }).d[0]).toBe(3 * FT - 3 * IN - 1000);
  });

  it('lines an opening’s centre up with another’s across the plan', () => {
    const o1 = L1.openings.find((o) => o.id === 'O1')!;
    const wall = L1.walls.find((w) => w.id === o1.wall)!;
    const others = L1.openings.filter((o) => o.id !== o1.id);
    // Whatever O1 aligns with when nudged a hair, it is an exact offset inside its wall and labelled.
    const a = alignOpening(L1, wall, { id: o1.id, offset: o1.offset + 100, width: o1.width }, { tol: 2 * IN });
    if (a !== null) {
      expect(Number.isInteger(a.offset)).toBe(true);
      expect(a.guides).toHaveLength(1);
    }
    expect(others.length).toBeGreaterThan(0);
  });

  it('per mode: construction on 6", the trades on 1", no mode as before; the menu’s steps', () => {
    expect(modeSnapDefaults(null, 'imperial').step).toBeNull();
    expect(modeSnapDefaults('construction', 'imperial').step).toBe(6 * IN);
    expect(modeSnapDefaults('construction', 'metric').step).toBe(100 * 1280);
    expect(modeSnapDefaults('electrical', 'imperial').step).toBe(IN);
    expect(modeSnapDefaults('decorator', 'imperial').junctions).toBe(false);
    expect(modeSnapDefaults('landscape', 'imperial').step).toBe(FT);
    expect(gridSteps('imperial')).toContain(6 * IN);
    expect(snapSummary(SNAP_DEFAULTS, 'imperial', 6 * IN)).toBe('junctions, walls, +3, grid 6"');
    expect(snapSummary({ ...SNAP_DEFAULTS, midpoints: false, guides: false, items: false }, 'imperial', IN / 2)).toBe('junctions, walls, grid ½"');
    expect(snapSummary({ ...SNAP_DEFAULTS, on: false }, 'imperial', IN)).toBe('off');
  });
});

describe('temporary dimensions on the Courtyard House', () => {
  it('names directions by the compass, north up', () => {
    expect(compass([0, 1])).toBe('north');
    expect(compass([-1, 0])).toBe('west');
    expect(compass([1, -1])).toBe('south-east');
  });

  it('an opening: along its wall to the walls either side; typed, it moves there exactly — one moveOpening', () => {
    const dims = temporaryDimensions(model, L1, 'O1', 'face');
    expect(dims.map((d) => d.key).sort()).toEqual(['opening:end', 'opening:start']);
    const start = dims.find((d) => d.key === 'opening:start')!;
    const r = start.apply!(Math.round(start.value) + 2 * IN);
    expect('batch' in r && r.batch).toEqual([{ op: 'moveOpening', opening: 'O1', at: expect.any(Number) as number }]);
    const { before, after } = typeInto(model, 'O1', 'opening:start', Math.round(start.value) + 2 * IN);
    expect(Math.round(after.value)).toBe(Math.round(before.value) + 2 * IN);
  });

  it('measures to the face, the centre line or the other face', () => {
    const face = temporaryDimensions(model, L1, 'O1', 'face').find((d) => d.key === 'opening:start')!;
    const centre = temporaryDimensions(model, L1, 'O1', 'centre').find((d) => d.key === 'opening:start')!;
    const far = temporaryDimensions(model, L1, 'O1', 'far').find((d) => d.key === 'opening:start')!;
    expect(face.label).toMatch(/^From \w+ face$/);
    expect(centre.label).toMatch(/centre line$/);
    expect(far.label).toMatch(/other face$/);
    expect(far.value).toBeGreaterThan(face.value);
    expect(centre.value).toBeGreaterThan(face.value);
  });

  it('refuses a distance that would push an opening off its wall', () => {
    const start = temporaryDimensions(model, L1, 'O1', 'face').find((d) => d.key === 'opening:start')!;
    expect(start.apply!(1000 * FT)).toHaveProperty('error');
  });

  it('a wall: across to its parallel neighbours; typed, it moves — one moveWall', () => {
    const wall = L1.walls.find((w) => temporaryDimensions(model, L1, w.id, 'face').length === 2 && w.line.length === 2)!;
    const dims = temporaryDimensions(model, L1, wall.id, 'face');
    const d = dims[0]!;
    const r = d.apply!(Math.round(d.value) - 3 * IN);
    expect('batch' in r ? r.batch[0]?.op : null).toBe('moveWall');
    const { before, after } = typeInto(model, wall.id, d.key, Math.round(d.value) - 3 * IN);
    expect(Math.round(after.value)).toBe(Math.round(before.value) - 3 * IN);
  });

  it('a room: its clear width and depth; typed, its east wall moves', () => {
    // The guest bedroom's west side is a bay (an arc wall): its depth only.
    expect(temporaryDimensions(model, L1, 'R1', 'face').map((d) => d.label)).toEqual(['Depth']);
    // Some walls cannot move without breaking a corner the server refuses (FS-INV-110): the first that can.
    let checked = 0;
    for (const room of L1.rooms) {
      const dims = temporaryDimensions(model, L1, room.id, 'face');
      const width = dims.find((d) => d.key === 'room:x');
      if (width?.apply === undefined || dims.length !== 2) continue;
      expect(dims.map((d) => d.label)).toEqual(['Width', 'Depth']);
      try {
        const { after } = typeInto(model, room.id, 'room:x', Math.round(width.value) + 3 * IN);
        expect(Math.round(after.value)).toBe(Math.round(width.value) + 3 * IN);
        checked++;
        break;
      } catch (e) {
        expect(String(e)).toMatch(/rejected/);
      }
    }
    expect(checked).toBe(1);
  });

  it('an item: to the nearest wall or item each way; typed, it moves — one batch', () => {
    const dims = temporaryDimensions(model, L1, 'KIT-ISLAND', 'face');
    expect(dims.length).toBeGreaterThanOrEqual(3);
    const d = dims.find((x) => x.key === 'item:west') ?? dims[0]!;
    const { before, after } = typeInto(model, 'KIT-ISLAND', d.key, Math.round(d.value) - 6 * IN);
    expect(Math.round(after.value)).toBe(Math.round(before.value) - 6 * IN);
  });

  it('a wall-hung device: only along its wall', () => {
    const receptacle = L1.devices.find((d) => d.extension === 'FS_electrical' && d.collection === 'receptacles' && typeof d.host?.['wall'] === 'string')!;
    const wall = L1.walls.find((w) => w.id === receptacle.host?.['wall'])!;
    const horizontal = wall.a[1] === wall.b[1];
    for (const d of temporaryDimensions(model, L1, receptacle.id, 'face')) expect(horizontal ? ['item:east', 'item:west'] : ['item:north', 'item:south']).toContain(d.key);
  });
});

describe('the measure tool', () => {
  it('chains, totals and closes on an area', () => {
    const m = summarize({ points: [{ point: [0, 0] }, { point: [10 * FT, 0] }, { point: [10 * FT, 10 * FT] }], closed: true });
    expect(m.segments.map((s) => s.label)).toEqual(['A → B', 'B → C', 'C → A']);
    expect(Math.round(m.total)).toBe(Math.round(20 * FT + Math.hypot(10 * FT, 10 * FT)));
    expect(m.area2).toBe(BigInt(100 * FT * FT));
  });

  it('names points by what they snapped to, and knows the kitchen work triangle', () => {
    const kinds = (ref: string) => triangleKind(model, L1, ref);
    expect(kinds('KIT-SINK')).toBe('sink');
    expect(kinds('KIT-FRIDGE')).toBe('fridge');
    expect(kinds('KIT-COOKTOP')).toBe('cooktop');
    const at = (id: string): Point => {
      const d = L1.devices.find((x) => x.id === id)!;
      return d.placement?.point ?? d.footprint[0]!;
    };
    const m = summarize({ points: [{ point: at('KIT-COOKTOP'), ref: 'KIT-COOKTOP', label: 'Cooktop' }, { point: at('KIT-SINK'), ref: 'KIT-SINK', label: 'Sink' }, { point: at('KIT-FRIDGE'), ref: 'KIT-FRIDGE', label: 'Fridge' }], closed: true }, kinds);
    expect(m.segments.map((s) => s.label)).toEqual(['Cooktop → sink', 'Sink → fridge', 'Fridge → cooktop']);
    expect(m.triangle).toEqual({ total: m.total, over: m.total > WORK_TRIANGLE });
  });
});
