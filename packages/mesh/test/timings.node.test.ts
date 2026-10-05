/**
 * Interactive speed: the layout solver's three-bedroom ranch under a hip roof, meshed whole. The
 * bound is generous so the test never flakes on a slow runner; the timings are printed
 * (`pnpm --filter @floorspec/mesh timings`).
 */
import { describe, expect, it } from 'vitest';
import { deriveEvaluation, evaluate } from '@floorspec/engine';
import { loadMesher } from '../src/index.js';
import { ranch } from './houses.js';

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

describe('timings', () => {
  it('meshes the ranch fast enough for an interactive view', async () => {
    const doc = ranch();
    let t = performance.now();
    const mesher = await loadMesher();
    const load = performance.now() - t;
    const ev = evaluate(doc);
    const derived = deriveEvaluation(ev);
    const whole: number[] = [];
    const meshOnly: number[] = [];
    const derive: number[] = [];
    let parts = 0;
    let triangles = 0;
    for (let i = 0; i < 15; i++) {
      t = performance.now();
      const m = mesher.meshDocument(doc);
      whole.push(performance.now() - t);
      t = performance.now();
      deriveEvaluation(evaluate(doc));
      derive.push(performance.now() - t);
      t = performance.now();
      mesher.meshDerived(ev.document!, derived);
      meshOnly.push(performance.now() - t);
      parts = m.parts.length;
      triangles = m.parts.reduce((s, p) => s + p.mesh.indices.length / 3, 0);
    }
    const line = `ranch: ${parts} parts, ${triangles} triangles; manifold-3d load ${load.toFixed(1)} ms; median of 15 — validate+derive ${median(derive).toFixed(1)} ms, mesh ${median(meshOnly).toFixed(1)} ms, meshDocument ${median(whole).toFixed(1)} ms`;
    console.info(line);
    expect(median(meshOnly)).toBeLessThan(1000);
  });
});
