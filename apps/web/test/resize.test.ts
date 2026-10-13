/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apply } from '@floorspec/ops';
import { islandBays } from '@floorspec/mesh';
import { OFFICIAL_READER } from '@floorspec/engine';
import { readModel } from '../src/editor/model';
import type { Batch } from '../src/editor/ops';
import type { DeviceView } from '../src/editor/systems/view';
import { boxOf, dragResize, dragRotate, FT, handlesOf, IN, isResizable, modelKind, middleOf, positionKeepingMiddle, resizeBatch, ruleFor, sizeOf, snapExtent, toPlan, frameVectors, turnBatch } from '../src/furniture/resize';

/**
 * FLR-T-18.4 in the editor: the Courtyard House's island (a copy of the owner's house, the staging
 * assistant's fixture) resized and turned through the real applier, as the server applies it.
 */

const HOUSE = readFileSync(new URL('../../../packages/assistants/staging/test/fixtures/courtyard.floorspec.json', import.meta.url), 'utf8');

function commit(doc: string, batch: Batch): string {
  const r = apply(doc, { batch }, OFFICIAL_READER);
  if (r.status !== 'committed') throw new Error(`rejected: ${r.diagnostics.map((d) => `${d.code} ${d.message}`).join('; ')}`);
  return r.document;
}
const deviceIn = (doc: string, id: string): DeviceView => readModel('h', doc).levels.flatMap((l) => l.devices).find((d) => d.id === id)!;

describe('resizing an item', () => {
  const island = deviceIn(HOUSE, 'KIT-ISLAND');

  it('knows what it can resize, and the island is procedural', () => {
    expect(isResizable(island)).toBe(true);
    expect(sizeOf(boxOf(island.element)!)).toEqual({ depth: 1_152_000, width: 2_304_000, height: 1_152_000 });
    expect(modelKind(readModel('h', HOUSE).document, island)).toBe('procedural');
    expect(isResizable(deviceIn(HOUSE, readModel('h', HOUSE).levels.flatMap((l) => l.devices).find((d) => d.extension === 'FS_electrical')!.id))).toBe(false);
  });

  it('snaps casework to the 3" module and to common sizes, inside its limits', () => {
    const rule = ruleFor(island);
    expect(snapExtent(rule, 'width', 100 * IN, false)).toBe(99 * IN);
    expect(snapExtent(rule, 'width', 119 * IN, false)).toBe(120 * IN);
    expect(snapExtent(rule, 'width', 10 * IN, false)).toBe(36 * IN);
    expect(snapExtent(rule, 'width', 100 * IN + 3, true)).toBe(100 * IN);
    const bed = ruleFor({ extension: 'FS_furniture', element: { category: 'bed' } });
    expect(snapExtent(bed, 'width', 59 * IN, false)).toBe(60 * IN);
  });

  it('makes the island 10 ft long as one resizeElement: the cooktop with it stays at its middle and rises with its top', () => {
    const batch = resizeBatch('KIT-ISLAND', 'center', { width: 10 * FT, height: 42 * IN }, ruleFor(island));
    expect(batch).toEqual([{ op: 'resizeElement', element: 'KIT-ISLAND', anchor: 'center', width: 10 * FT, height: 42 * IN, limits: { width: { min: 36 * IN, max: 168 * IN }, height: { min: 24 * IN, max: 48 * IN } } }]);
    const after = commit(HOUSE, batch);
    const big = deviceIn(after, 'KIT-ISLAND');
    expect(boxOf(big.element)).toEqual({ min: [0, -60 * IN, 0], max: [1_152_000, 60 * IN, 42 * IN] });
    const cooktop = deviceIn(after, 'KIT-COOKTOP');
    expect(cooktop.host).toEqual(deviceIn(HOUSE, 'KIT-COOKTOP').host);
    expect(boxOf(cooktop.element)!.min[2]).toBe(42 * IN);
    expect(islandBays(1_152_000, 2_304_000)).toBe(3);
    expect(islandBays(1_152_000, 10 * FT)).toBe(5);
  });

  it('drags a handle: the opposite side holds, the size snaps; ⌥ grows from the middle', () => {
    const left = handlesOf(island).find((h) => h.side === 'left')!;
    const f = frameVectors(island);
    const b = boxOf(island.element)!;
    const r = dragResize(island, left, toPlan(f, 500_000, b.max[1] + 20 * IN), { free: false, centre: false, keepRatio: false })!;
    expect(r.anchor).toBe('right');
    expect(r.size.width! % (3 * IN)).toBe(0);
    expect(Math.abs(r.size.width! - (2_304_000 + 20 * IN))).toBeLessThanOrEqual(2 * IN);
    const centred = dragResize(island, left, toPlan(f, 500_000, b.max[1] + 20 * IN), { free: false, centre: true, keepRatio: false })!;
    expect(centred.anchor).toBe('center');
    const after = commit(HOUSE, resizeBatch('KIT-ISLAND', r.anchor, r.size, ruleFor(island)));
    expect(boxOf(deviceIn(after, 'KIT-ISLAND').element)!.min[1]).toBe(b.min[1]);
  });

  it('turns about its middle in 15° steps, as one batch', () => {
    const mid = middleOf(island)!;
    // The rotate handle is behind its back: pointing the pointer east turns it to face west.
    const t = dragRotate(island, [mid[0] + 10 * FT, mid[1] + 0.3 * FT], false)!;
    expect(t.rotation).toBe(180_000_000);
    expect(positionKeepingMiddle(island, island.placement!.facing)).toEqual(island.host!['position']);
    const after = commit(HOUSE, turnBatch(island, t.rotation));
    const turned = deviceIn(after, 'KIT-ISLAND');
    const m2 = middleOf(turned)!;
    expect(Math.hypot(m2[0] - mid[0], m2[1] - mid[1])).toBeLessThan(2);
  });
});
