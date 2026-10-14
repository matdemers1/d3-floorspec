/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { apply } from '@floorspec/ops';
import { OFFICIAL_READER } from '@floorspec/engine';
import { readModel, type EditorModel, type Point } from '../src/editor/model';
import type { Batch } from '../src/editor/ops';
import { ridersOf } from '../src/editor/arrange/riders';
import { carryRiders, frameMotion } from '../src/editor/arrange/carry';
import { mirror, quarterTurn, transformBatch, translation } from '../src/editor/arrange/transform';
import { arrayBatch, defaultSpec } from '../src/editor/arrange/array';
import { rigidPreview } from '../src/editor/rigid';
import { turnBatch, resizeBatch, ruleFor } from '../src/furniture/resize';
import { moveDevice } from '../src/editor/systems/ops';
import { EditorStore } from '../src/editor/store';
import { ToolController, type PointerInfo } from '../src/editor/tools';
import { toScreen } from '../src/editor/viewport';
import { centroid } from '../src/editor/geometry';
import type { DeviceView } from '../src/editor/systems/view';

/**
 * FLR-T-18.18, on the Courtyard House (the worker's fixture): a moved, turned, resized or arrayed
 * item carries what sits on it — the island its cooktop (`with`), the FS_mechanical gas cooktop on
 * its top and the bowl on it; a dragged item keeps the pointer's offset from it; the drag preview of
 * a device move is rigid (no derive) and agrees with the full apply.
 */

const HOUSE = readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8');
const base = readModel('h', HOUSE);
const level = base.levels.find((l) => l.devices.some((d) => d.id === 'KIT-ISLAND'))!;
const dev = (m: EditorModel, id: string): DeviceView => m.levels.flatMap((l) => l.devices).find((d) => d.id === id)!;
const pos = (m: EditorModel, id: string): [number, number] => dev(m, id).host!['position'] as [number, number];
const island = dev(base, 'KIT-ISLAND');
const [ix, iy] = pos(base, 'KIT-ISLAND');

function applied(batch: Batch, model: EditorModel = base): EditorModel {
  const r = apply(model.document, { batch }, OFFICIAL_READER);
  if (r.status !== 'committed') throw new Error(`rejected: ${r.diagnostics.map((d) => `${d.code} ${d.message}`).join('; ')}`);
  return readModel('p', r.document);
}

const near = (a: Point, b: Point, tol = 2) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;

describe('what rides on an item', () => {
  it('finds the island’s cooktop, the gas cooktop on its top and the bowl on it — and nothing around it', () => {
    const riders = ridersOf(level, ['KIT-ISLAND']);
    expect(riders).toEqual(expect.arrayContaining(['KIT-COOKTOP', 'KIT-COOKTOP-G', 'R8-BOWL1']));
    expect(riders).toHaveLength(3);
    // The counter beside it, the pendants over it, the island itself: not carried.
    expect(riders).not.toContain('KIT-B5');
    expect(riders).not.toContain('L-KIT-P1');
  });

  it('carries a bed’s nightstands and what stands on them, but not the picture on the wall over it', () => {
    const bedLevel = base.levels.find((l) => l.devices.some((d) => d.id === 'GB-BED'))!;
    const riders = ridersOf(bedLevel, ['GB-BED']);
    expect(riders).toEqual(expect.arrayContaining(['GB-NS1', 'GB-NS2', 'R1-LAMP1', 'R1-LAMP2']));
    expect(riders).not.toContain('R1-ART1');
    // A nightstand carries its lamp; it does not carry the bed it is grouped with.
    expect(ridersOf(bedLevel, ['GB-NS1'])).not.toContain('GB-BED');
  });

  it('takes a dishwasher’s FS_plumbing fixture with it, and the fixture its dishwasher', () => {
    expect(ridersOf(level, ['KIT-DW'])).toEqual(['KIT-DW-P']);
    expect(ridersOf(level, ['KIT-DW-P'])).toEqual(['KIT-DW']);
  });
});

describe('carrying in the same batch', () => {
  it('moves the cooktops and the bowl with the island when it is moved alone (a drag, an arrow, a typed position)', () => {
    const by: Point = [-640_000, 320_000];
    const batch = carryRiders(base, moveDevice('KIT-ISLAND', { mode: 'surface', room: 'R8', surface: 'floor', at: [ix + by[0], iy + by[1]], rotation: 90_000_000 }));
    expect(batch.length).toBe(4);
    const after = applied(batch);
    for (const id of ['KIT-COOKTOP', 'KIT-COOKTOP-G', 'R8-BOWL1']) {
      const [x, y] = pos(base, id);
      expect(pos(after, id)).toEqual([x + by[0], y + by[1]]);
    }
    // Still on the island: the cooktop's footprint inside the island's.
    expect(near(centroid(dev(after, 'KIT-COOKTOP').footprint), centroid(dev(base, 'KIT-COOKTOP').footprint).map((v, i) => v + (by[i] as number)) as unknown as Point)).toBe(true);
  });

  it('leaves alone a rider the batch moves itself', () => {
    const batch: Batch = [
      ...moveDevice('KIT-ISLAND', { mode: 'surface', room: 'R8', surface: 'floor', at: [ix + 12_800, iy], rotation: 90_000_000 }),
      ...moveDevice('R8-BOWL1', { mode: 'surface', room: 'R8', surface: 'floor', at: [0, 0], rotation: 0 }),
    ];
    const carried = carryRiders(base, batch);
    expect(carried.filter((op) => (op as { element?: string }).element === 'R8-BOWL1')).toHaveLength(1);
  });

  it('turns them about the island’s middle when the island is turned (the rotate handle)', () => {
    const turned = applied(carryRiders(base, turnBatch(island, 0)));
    const mid = centroid(dev(turned, 'KIT-ISLAND').footprint);
    expect(near(mid, centroid(island.footprint))).toBe(true);
    // The cooktop shares the island's origin and facing before and after: turned with it, in its frame.
    expect(pos(base, 'KIT-COOKTOP')).toEqual([ix, iy]);
    expect(pos(turned, 'KIT-COOKTOP')).toEqual(pos(turned, 'KIT-ISLAND'));
    expect(dev(turned, 'KIT-COOKTOP').host!['rotation'] ?? 0).toBe(0);
    expect(pos(turned, 'KIT-COOKTOP-G')).toEqual(pos(turned, 'KIT-COOKTOP'));
  });

  it('moves the gas cooktop as resizeElement moves the grouped cooktop (Ops 0.4, 4.11), and raises it with the top', () => {
    const resized = applied(carryRiders(base, resizeBatch('KIT-ISLAND', 'back', { depth: 1_536_000, height: 1_216_000 }, ruleFor(island))));
    expect(pos(resized, 'KIT-COOKTOP-G')).toEqual(pos(resized, 'KIT-COOKTOP'));
    const box = (id: string) => ((dev(resized, id).element['fallback'] as { box: { min: number[] } }).box.min[2]);
    expect(box('KIT-COOKTOP')).toBe(1_216_000);
    expect(box('KIT-COOKTOP-G')).toBe(1_216_000);
  });

  it('carries them in a transform of a selection — moved, turned a quarter, mirrored — as one batch', () => {
    const c = centroid(island.footprint);
    for (const xf of [translation([128_000, -256_000]), quarterTurn(c, 1), mirror(c, 'h')]) {
      const t = transformBatch(base, level, ['KIT-ISLAND'], xf);
      expect(t.moved).toEqual(['KIT-ISLAND']);
      const after = applied(t.batch);
      // The cooktop stays at the island's origin, however it was transformed.
      expect(pos(after, 'KIT-COOKTOP')).toEqual(pos(after, 'KIT-ISLAND'));
      expect(pos(after, 'KIT-COOKTOP-G')).toEqual(pos(after, 'KIT-COOKTOP'));
      expect(t.batch.filter((op) => (op as { element?: string }).element === 'KIT-COOKTOP')).toHaveLength(1);
    }
  });

  it('copies them with each copy of an array, grouped with that copy', () => {
    const spec = { ...defaultSpec(level, ['KIT-ISLAND'], true), mode: 'line' as const, count: 2, spacing: 3_200_000, direction: 0 as const };
    const { batch, ids } = arrayBatch(base, level, ['KIT-ISLAND'], spec, { attempt: 0, project: 'p' });
    // What is selected after: the island's copy alone.
    expect(ids).toHaveLength(1);
    const after = applied(batch);
    const copy = ids[0]!;
    const withCopy = after.levels.flatMap((l) => l.devices).filter((d) => d.element['with'] === copy).map((d) => d.element['name']);
    expect(withCopy.sort()).toEqual(['Cooktop, 760 mm', 'Fruit bowl']);
    // The gas cooktop is copied too (FS_mechanical, so not grouped by `with`), on the copy's top.
    expect(after.levels.flatMap((l) => l.devices).filter((d) => d.collection === 'gasAppliances').length).toBe(level.devices.filter((d) => d.collection === 'gasAppliances').length + 1);
  });
});

describe('the rigid drag preview', () => {
  const batch = carryRiders(base, moveDevice('KIT-ISLAND', { mode: 'surface', room: 'R8', surface: 'floor', at: [ix + 512_000, iy - 128_000], rotation: 90_000_000 }));

  it('draws the moved devices where the full apply puts them — footprints, envelopes, placements', () => {
    const rigid = rigidPreview(base, batch)!;
    const exact = applied(batch);
    expect(rigid).not.toBeNull();
    for (const id of ['KIT-ISLAND', 'KIT-COOKTOP', 'KIT-COOKTOP-G', 'R8-BOWL1']) {
      const a = dev(rigid, id);
      const b = dev(exact, id);
      a.footprint.forEach((p, i) => { expect(near(p, b.footprint[i]!)).toBe(true); });
      a.clearances.forEach((c, k) => { c.ring.forEach((p, i) => { expect(near(p, b.clearances[k]!.ring[i]!)).toBe(true); }); });
      expect(near(a.placement!.point, b.placement!.point)).toBe(true);
      expect(a.host).toEqual(b.host);
      expect(rigid.derived!.clearances![id]).toEqual(exact.derived!.clearances![id] === undefined ? undefined : expect.anything());
    }
    // Everything else is shared, not copied.
    const other = base.levels.find((l) => l.id !== level.id)!;
    expect(rigid.levels.find((l) => l.id === other.id)).toBe(other);
  });

  it('agrees with the full apply for a turn, at any angle', () => {
    const b2 = carryRiders(base, turnBatch(island, 30_000_000));
    const rigid = rigidPreview(base, b2)!;
    const exact = applied(b2);
    for (const id of ['KIT-ISLAND', 'KIT-COOKTOP']) dev(rigid, id).footprint.forEach((p, i) => { expect(near(p, dev(exact, id).footprint[i]!, 4)).toBe(true); });
  });

  it('is not used for anything but devices moved on their level', () => {
    expect(rigidPreview(base, resizeBatch('KIT-ISLAND', 'back', { depth: 1_536_000 }, ruleFor(island)))).toBeNull();
    expect(rigidPreview(base, [{ op: 'moveWall', wall: level.walls[0]!.id, by: 12_800 } as unknown as Batch[number]])).toBeNull();
  });

  it('costs a small part of a frame where the full apply costs several', () => {
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) rigidPreview(base, carryRiders(base, batch));
    const rigidMs = (performance.now() - t0) / 20;
    const t1 = performance.now();
    applied(batch);
    const fullMs = performance.now() - t1;
    expect(rigidMs).toBeLessThan(fullMs / 5);
    expect(rigidMs).toBeLessThan(8);
  });

  it('turns rigid frames for a quarter turn exactly', () => {
    const xf = frameMotion({ point: [0, 0], angle: 0 }, { point: [10, 0], angle: 90_000_000 });
    expect(xf.map([5, 0])).toEqual([10, 5]);
  });
});

describe('dragging keeps the grab offset', () => {
  let store: EditorStore;
  let tools: ToolController;
  const view = { cx: ix, cy: iy, s: 16 / 390_144, w: 1200, h: 800 };
  const at = (p: Point, extra: Partial<PointerInfo> = {}): PointerInfo => {
    const q = toScreen(view, p);
    return { id: 1, x: q[0], y: q[1], type: 'mouse', button: 0, shift: false, alt: false, detail: 1, ...extra };
  };

  beforeAll(() => {
    const g = globalThis as unknown as { requestAnimationFrame?: (cb: () => void) => number; cancelAnimationFrame?: (n: number) => void };
    g.requestAnimationFrame ??= (cb) => setTimeout(cb, 0) as unknown as number;
    g.cancelAnimationFrame ??= (n) => { clearTimeout(n); };
  });

  function grab(id: string, by: Point): { start: Point; host: Record<string, unknown> | null } {
    store = new EditorStore('p');
    store.set({ status: 'ready', model: base, level: level.id, view, selection: id, selected: [id] });
    tools = new ToolController(store);
    const d = dev(base, id);
    // Grabbed well off its middle: a quarter of the way along its length.
    const c = centroid(d.footprint);
    const corner = d.footprint[0]!;
    const start: Point = [c[0] + (corner[0] - c[0]) * 0.5, c[1] + (corner[1] - c[1]) * 0.5];
    tools.down(at(start));
    tools.move(at([start[0] + by[0], start[1] + by[1]], { alt: true }));
    const draft = store.get().draft;
    const drag = draft?.tool === 'select' ? draft.drag : null;
    return { start, host: drag?.kind === 'device' ? (drag.hover.host) : null };
  }

  it('moves the island by as much as the pointer, from where it was grabbed — no jump to its middle', () => {
    const { host } = grab('KIT-ISLAND', [0, 0]);
    // Not moved past the drag threshold: no drag at all.
    expect(host).toBeNull();
    const by: Point = [390_144, -195_072];
    const moved = grab('KIT-ISLAND', by);
    expect(moved.host).not.toBeNull();
    const [x, y] = moved.host!['at'] as [number, number];
    // ⌥ held: free of the grid and the guides — exactly the pointer's movement.
    expect(Math.abs(x - (ix + by[0]))).toBeLessThanOrEqual(1);
    expect(Math.abs(y - (iy + by[1]))).toBeLessThanOrEqual(1);
  });

  it('previews the island with what it carries, rigidly, and sends them in one batch on release', async () => {
    const by: Point = [390_144, 0];
    grab('KIT-ISLAND', by);
    await new Promise((r) => setTimeout(r, 5));
    const preview = store.get().preview;
    expect(preview?.rigid).toEqual({ exact: false });
    const [cx, cy] = pos(base, 'KIT-COOKTOP');
    expect(dev(preview!.model!, 'KIT-COOKTOP').host!['position']).toEqual([cx + by[0], cy + by[1]]);
    // Resting, the full apply runs once for the findings.
    await new Promise((r) => setTimeout(r, 250));
    expect(store.get().preview?.rigid).toEqual({ exact: true });
    expect(dev(store.get().preview!.model!, 'KIT-COOKTOP').host!['position']).toEqual([cx + by[0], cy + by[1]]);
  });
});

describe('a room dragged by its floor keeps the grab offset too', () => {
  it('moves by the pointer’s movement, not to it', async () => {
    const { roomDrag } = await import('../src/editor/rooms/edit');
    expect(roomDrag([100, 100], [100 + 390_144, 100], { grid: 32_512, free: false, axis: false })).toEqual([390_144, 0]);
  });
});

