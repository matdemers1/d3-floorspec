/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { describe, expect, it } from 'vitest';
import { SKY_PRESETS, skyRadiance as meshSkyRadiance } from '@floorspec/mesh/sky';
import { directOf, EXPOSURE, exposureOf, LUX_PER_UNIT as CPU_LUX_PER_UNIT, resolveSky, SKIES } from '../src/pathtrace/index.js';
import { DEFAULT_SUN as GPU_DEFAULT_SUN, EXPOSURE_BAND, LUX_PER_UNIT, meteredExposure, meterFloor, skyPixels, stillSun, TIMES } from '../../web/src/editor/three/still/gpu/sky.js';

/**
 * FLR-ADR-040: two light-transport implementations must agree. Since FLR-T-13.4 the editor's GPU
 * still and this tracer read one sky — @floorspec/mesh's presets, sun and HDRI dome — so what is
 * held here is that each turns it into its own frame and units the same way: the sun's direction
 * and illuminance, and the sky's radiance along every direction.
 */

const site = { site: { location: { latitude: 33_749_000, longitude: -84_388_000 }, trueNorth: 12_500_000 } };

describe('the GPU still’s sun and sky are the path tracer’s', () => {
  it('offers the same presets, and the same default sun', () => {
    expect([...SKIES]).toEqual([...SKY_PRESETS]);
    expect(GPU_DEFAULT_SUN).toEqual({ azimuth: 225, altitude: 35 });
  });

  it('places and sizes the direct light the same, 12 500 lx to the tracer’s unit', () => {
    for (const sky of SKY_PRESETS)
      for (const at of ['2026-06-21T19:30-04:00', '2026-12-21T09:00-05:00', '2026-03-20T23:00-04:00']) {
        const r = resolveSky(site, { sky, at });
        const cpu = directOf(r);
        const gpu = stillSun(r.light);
        if (gpu === null) {
          expect(cpu.irradiance).toBe(0);
          continue;
        }
        gpu.dir.forEach((c, k) => { expect(c).toBeCloseTo(cpu.dir[k]!, 12); });
        gpu.color.forEach((c, k) => { expect(c).toBeCloseTo(cpu.color[k]!, 12); });
        expect(gpu.lux).toBeCloseTo(cpu.irradiance * LUX_PER_UNIT, 6);
      }
  });

  it('draws the same sky along every direction, in cd/m², each in its own frame', () => {
    const r = resolveSky(site, { sky: 'clear', at: '2026-06-21T18:00-04:00' });
    const W = 32;
    const H = 16;
    const gpu = skyPixels(r.field, W, H);
    const L = new Float64Array(3);
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        // three.js's equirectangular direction, in the scene's frame (+Y up, −Z project north)…
        const theta = ((j + 0.5) / H - 0.5) * Math.PI;
        const phi = ((i + 0.5) / W - 0.5) * 2 * Math.PI;
        const d = [Math.cos(theta) * Math.cos(phi), Math.sin(theta), Math.cos(theta) * Math.sin(phi)] as const;
        // …is the project's (x, −z, y), where the tracer reads the shared sky.
        meshSkyRadiance(r.field, [d[0], -d[2], d[1]], L);
        for (let c = 0; c < 3; c++) expect(gpu[4 * (j * W + i) + c]).toBeCloseTo(L[c]!, 1);
      }
  });

  it('meters within the same bands as the path tracer (FLR-T-13.1), in the same unit', () => {
    expect(LUX_PER_UNIT).toBe(CPU_LUX_PER_UNIT);
    for (const time of TIMES) {
      expect(EXPOSURE_BAND[time].min * LUX_PER_UNIT).toBeCloseTo(EXPOSURE[time].min, 12);
      expect(EXPOSURE_BAND[time].max * LUX_PER_UNIT).toBeCloseTo(EXPOSURE[time].max, 12);
      // An image of one luminance, bright, dim and all but black: the same exposure either way.
      for (const nits of [30_000, 800, 50, 3, 0.01]) {
        const units = nits / LUX_PER_UNIT;
        const hdr = new Float32Array(3 * 16).fill(units);
        const floor = meterFloor(time);
        const gpu = meteredExposure(Math.exp(Math.log(floor + nits)), time);
        expect(gpu * LUX_PER_UNIT, `${time} ${String(nits)} cd/m²`).toBeCloseTo(exposureOf(hdr, 4, 4, EXPOSURE[time]), 6);
      }
    }
  });
});
