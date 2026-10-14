/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apply } from '@floorspec/ops';
import { OFFICIAL_READER } from '@floorspec/engine';
import { readModel, type EditorModel } from '../src/editor/model';
import type { Batch } from '../src/editor/ops';
import { depthOf, haloFrame, headline, indexOf, movingFrom, nearest, type Halo } from '../src/editor/halos/halos';

/**
 * FLR-T-18.14: clearance halos, on the Courtyard House (the worker's fixture). The island is moved
 * through the real applier, as a drag's preview is; the halos of the island and the counter beside
 * it are worked out from the preview's derived envelopes.
 */

const HOUSE = readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8');
const MM = 1_280;

function moved(doc: string, batch: Batch): EditorModel {
  const r = apply(doc, { batch }, OFFICIAL_READER);
  if (r.status !== 'committed') throw new Error(`rejected: ${r.diagnostics.map((d) => `${d.code} ${d.message}`).join('; ')}`);
  return readModel('p', r.document);
}

const base = readModel('h', HOUSE);
const level = base.levels.find((l) => l.devices.some((d) => d.id === 'KIT-ISLAND'))!;
const island = level.devices.find((d) => d.id === 'KIT-ISLAND')!;
const [x, y] = (island.element['host'] as { position: [number, number] }).position;
/** The island moved north (towards the counter of base cabinets) by `by`. */
const north = (by: number) => moved(HOUSE, [{ op: 'moveElement', element: 'KIT-ISLAND', host: { mode: 'surface', room: 'R8', surface: 'floor', at: [x, y + by], rotation: 90_000_000 } } as unknown as Batch[number]]);
const frame = (model: EditorModel): Halo[] => haloFrame(indexOf(base, level.id)!, movingFrom(model, level.id, ['KIT-ISLAND']));
const islandHalo = (halos: Halo[]) => halos.find((h) => h.owner === 'KIT-ISLAND' && h.name === 'front')!;

describe('clearance halos', () => {
  it('measures the gap between two shapes and an envelope’s depth', () => {
    expect(nearest([[0, 0], [10, 0], [10, 10], [0, 10]], [[15, 0], [20, 0], [20, 10], [15, 10]]).d).toBe(5);
    expect(nearest([[0, 0], [10, 0], [10, 10], [0, 10]], [[5, 5], [20, 5], [20, 6], [5, 6]]).d).toBe(0);
    // A front envelope 4 deep on a 10-wide item.
    expect(depthOf([[0, 10], [10, 10], [10, 14], [0, 14]], [[0, 0], [10, 0], [10, 10], [0, 10]])).toBe(4);
  });

  it('draws the island’s working space and its neighbours’ envelopes, clear where it stands', () => {
    const halos = frame(base);
    const own = islandHalo(halos);
    expect(own.moving).toBe(true);
    expect(own.purpose).toBe('workingSpace');
    expect(own.tone).toBe('clear');
    // Its neighbours: the counter's cabinets, the dishwasher, the fridge — within reach, not moving.
    const near = halos.filter((h) => !h.moving).map((h) => h.owner);
    expect(near).toEqual(expect.arrayContaining(['KIT-B5', 'KIT-DW']));
    // The cooktop set into it moves with it and has no envelope of its own; nothing far off is looked at.
    expect(halos.every((h) => h.owner !== 'KIT-COOKTOP')).toBe(true);
    expect(halos.length).toBeLessThan(40);
    expect(headline(halos, new Set(['KIT-ISLAND']))).toBeNull();
  });

  it('turns amber within 10 % of the depth, and red where the working space runs into the counter', () => {
    // The island's working space (1000 mm) ends 1519 mm short of the cabinets' fronts.
    const gap = 24_078_434 - (y + 1_152_000 + 1_280_000);
    const tight = frame(north(gap - 50 * MM));
    expect(islandHalo(tight).tone).toBe('tight');
    expect(islandHalo(tight).against!.spare).toBeCloseTo(50 * MM, -2);

    const red = frame(north(gap + 150 * MM));
    const own = islandHalo(red);
    expect(own.tone).toBe('conflict');
    expect(own.against!.kind).toBe('item');
    expect(own.against!.id).toMatch(/^KIT-(B\d|DW)$/);
    // The clear distance from the island to the counter, where it needs 1000 mm.
    expect(Math.round(own.against!.needs / MM)).toBe(1000);
    expect(Math.round(own.against!.clear / MM)).toBe(850);
    const head = headline(red, new Set(['KIT-ISLAND']))!;
    expect(head.owner).toBe('KIT-ISLAND');
    expect(head.tone).toBe('conflict');
  });

  it('turns a neighbour’s envelope red when the moving item stands in it', () => {
    // Far enough that the island itself is inside the cabinets' door clearance (600 mm).
    const halos = frame(north(24_078_434 - 768_000 - (y + 1_152_000) + 100 * MM));
    const cabinets = halos.filter((h) => !h.moving && h.owner.startsWith('KIT-B') && h.tone === 'conflict');
    expect(cabinets.length).toBeGreaterThan(0);
    expect(cabinets.every((h) => h.against!.id === 'KIT-ISLAND')).toBe(true);
  });

  it('respects grouping: an item never conflicts with what it is with', () => {
    const halos = frame(base);
    expect(halos.some((h) => h.against?.id === 'KIT-COOKTOP')).toBe(false);
  });

  it('computes a frame quickly: the index once, a frame only near the moving item', () => {
    const model = north(500 * MM);
    indexOf(base, level.id);
    const moving = movingFrom(model, level.id, ['KIT-ISLAND']);
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) haloFrame(indexOf(base, level.id)!, moving);
    const per = (performance.now() - t0) / 100;
    expect(per).toBeLessThan(8);
  });
});
