/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SUN, skyRadiance, sunOf, type Sun } from '../src/pathtrace/index.js';
import { DEFAULT_SUN as GPU_DEFAULT_SUN, GROUND, LUX_PER_UNIT, SKY_SCALE, skyRadiance as gpuSkyRadiance, sunOf as gpuSunOf } from '../../web/src/editor/three/still/gpu/sky.js';

/**
 * FLR-ADR-040: two light-transport implementations must agree. The editor's GPU still (FLR-T-13.13)
 * lights the house with this tracer's sun and sky, in photometric units — so the two are held to
 * each other here, sun by sun and direction by direction, until FLR-T-13.4 shares the sky presets.
 */

const SUNS = [DEFAULT_SUN, { azimuth: 90, altitude: 10 }, { azimuth: 300, altitude: 70 }, { azimuth: 180, altitude: 2 }];

describe('the GPU still’s sun and sky are the path tracer’s', () => {
  it('places and sizes the sun the same, 12 500 lx to the tracer’s unit', () => {
    expect(GPU_DEFAULT_SUN).toEqual(DEFAULT_SUN);
    for (const input of SUNS)
      for (const north of [0, 17.5, -40]) {
        const cpu = sunOf(input, north);
        const gpu = gpuSunOf(input, north);
        gpu.dir.forEach((c, k) => { expect(c).toBeCloseTo(cpu.dir[k]!, 12); });
        gpu.color.forEach((c, k) => { expect(c).toBeCloseTo(cpu.color[k]!, 12); });
        expect(gpu.lux).toBeCloseTo(cpu.irradiance * LUX_PER_UNIT, 6);
      }
  });

  it('gives the same sky radiance along every direction, in cd/m²', () => {
    const out = new Float64Array(3);
    for (const input of SUNS) {
      const cpu: Sun = sunOf(input, 0);
      const gpu = gpuSunOf(input, 0);
      for (let i = 0; i < 200; i++) {
        const t = (i * 0.61803398875) % 1;
        const z = 2 * ((i * 0.7548776662) % 1) - 1;
        const r = Math.sqrt(1 - z * z);
        const d: [number, number, number] = [r * Math.cos(2 * Math.PI * t), z, r * Math.sin(2 * Math.PI * t)];
        skyRadiance(d[0], d[1], d[2], cpu, out);
        gpuSkyRadiance(d, gpu).forEach((c, k) => { expect(c).toBeCloseTo(out[k]! * LUX_PER_UNIT, 6); });
      }
    }
  });

  it('dims the sky after sunset and stands the house on the same ground', () => {
    expect(SKY_SCALE.day).toEqual([1, 1, 1]);
    expect(SKY_SCALE.night[2]).toBeLessThan(0.001);
    expect(GROUND).toBe('#cfcabd');
  });
});
