/**
 * Generated rectilinear houses: a grid of rooms behind exterior and partition walls (L, T and X
 * junctions), doors and windows, a tray, vaulted or shed ceiling, a hip, gable, shed or flat roof
 * with or without a thickness and an overhang, a straight, L or U stair (sometimes turned 30°), a
 * patio slab. Every one must be valid by construction, and every property must hold.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { deriveEvaluation, evaluate } from '@floorspec/engine';
import { loadKernel, type Kernel } from '../src/kernel.js';
import { loadMesher, type Mesher } from '../src/index.js';
import { houseOf, houseSpec } from './houses.js';
import { checkHouse } from './props.js';

let kernel: Kernel;
let mesher: Mesher;
beforeAll(async () => {
  kernel = await loadKernel();
  mesher = await loadMesher();
});

describe('generated rectilinear houses', () => {
  it('are watertight, exact in volume and box, and cut through at every opening', () => {
    const seen = new Set<string>();
    fc.assert(
      fc.property(houseSpec, (spec) => {
        const doc = houseOf(spec);
        const ev = evaluate(doc);
        if (!ev.valid) expect.fail(`the generator made an invalid house: ${JSON.stringify(ev.diagnostics.filter((d) => d.severity === 'error').slice(0, 3))}`);
        const derived = deriveEvaluation(ev);
        const mesh = mesher.meshDerived(ev.document!, derived, { stats: true });
        const sum = checkHouse(kernel, ev.document!, derived, mesh, JSON.stringify(spec));
        expect(sum.openings).toBe(Object.keys(doc['openings'] as object).length);
        for (const p of mesh.parts) seen.add(p.kind);
      }),
      { numRuns: 80, seed: 20261005 },
    );
    for (const k of ['wall', 'junctionFill', 'opening', 'floor', 'ceiling', 'slab', 'roof', 'roofGable', 'stairFlight', 'stairLanding']) expect(seen, k).toContain(k);
  });
});
