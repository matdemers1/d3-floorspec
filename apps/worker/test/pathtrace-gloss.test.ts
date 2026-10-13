/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { describe, expect, it } from 'vitest';
import { GLASS_IOR, glassAt, paneTransmission, SKY_PRESETS, skyIlluminance, type SkyPreset } from '@floorspec/mesh/sky';
import { brdf, directOf, LUX_PER_UNIT, resolveSky, skyRadiance, trace, type PtMaterial, type PtScene, type Sun } from '../src/pathtrace/index.js';
import type { Camera } from '../src/render3d/camera.js';

/**
 * FLR-T-13.14 (FLR-ADR-040): the path tracer's gloss, metal and glass — GGX with Smith's masking and
 * Schlick's Fresnel, sampled along the normals the viewer sees; Fresnel glass by its ior, a thin
 * pane; and the sky presets every view shares — each against what it must be, so the CPU still and
 * the GPU still (whose glTF material is the same model) agree.
 */

const { alphaOf, fresnelDielectric, ggxD, lobeAlbedo, paneAbsorption, sampleVndf, schlick, smithG1, smithG2, smithLambda, smithV, thinPane } = brdf;
const lum = (c: ArrayLike<number>): number => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;

/** ∫ f(θ) sin θ dθ dφ over the upper hemisphere, for f depending on θ alone. */
function hemisphere(f: (cos: number) => number, n = 20_000): number {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const t = ((i + 0.5) / n) * (Math.PI / 2);
    s += f(Math.cos(t)) * Math.sin(t);
  }
  return s * (Math.PI / 2 / n) * 2 * Math.PI;
}

/** The single-bounce albedo of the GGX lobe for F = 1, ∫ D V (n·l) dω_l, by quadrature over directions. */
function albedoByQuadrature(mu: number, alpha: number): number {
  const a2 = alpha * alpha;
  const v = [Math.sqrt(1 - mu * mu), 0, mu];
  const N = 400;
  let s = 0;
  for (let i = 0; i < N; i++)
    for (let j = 0; j < 2 * N; j++) {
      const t = ((i + 0.5) / N) * (Math.PI / 2);
      const p = ((j + 0.5) / (2 * N)) * 2 * Math.PI;
      const l = [Math.sin(t) * Math.cos(p), Math.sin(t) * Math.sin(p), Math.cos(t)];
      const h = [l[0]! + v[0]!, l[1]!, l[2]! + v[2]!];
      const hl = Math.hypot(...h);
      s += ggxD(h[2]! / hl, a2) * smithV(l[2]!, mu, a2) * l[2]! * Math.sin(t);
    }
  return s * (Math.PI / 2 / N) * (Math.PI / N);
}

describe('GGX (brdf.ts)', () => {
  it('its distribution is normalized: ∫ D (n·h) dω = 1, for a mirror and for chalk', () => {
    for (const alpha of [0.02, 0.1, 0.3, 0.6, 1]) expect(hemisphere((c) => ggxD(c, alpha * alpha) * c, 200_000)).toBeCloseTo(1, 3);
  });

  it('Smith: G₁ in (0, 1], G₂ no more than either G₁, and the closed-form V is G₂ / 4 (n·l)(n·v)', () => {
    for (const alpha of [0.05, 0.4, 1])
      for (const nl of [0.05, 0.3, 0.7, 1])
        for (const nv of [0.1, 0.5, 0.9]) {
          const a2 = alpha * alpha;
          const g2 = smithG2(nl, nv, a2);
          expect(smithG1(nv, a2)).toBeGreaterThan(0);
          expect(smithG1(nv, a2)).toBeLessThanOrEqual(1);
          expect(g2).toBeLessThanOrEqual(Math.min(smithG1(nl, a2), smithG1(nv, a2)) + 1e-12);
          expect(smithV(nl, nv, a2)).toBeCloseTo(g2 / (4 * nl * nv), 9);
          // Reciprocal: the light and the viewer can trade places.
          expect(smithV(nv, nl, a2)).toBeCloseTo(smithV(nl, nv, a2), 12);
        }
  });

  it('sampling agrees with evaluating: the mean weight G₂/G₁(v) of the visible normals is the lobe’s albedo', () => {
    const h = new Float64Array(3);
    for (const alpha of [0.1, 0.35, 0.8])
      for (const mu of [0.2, 0.6, 1]) {
        const a2 = alpha * alpha;
        const v = [Math.sqrt(1 - mu * mu), 0, mu];
        const S = 128;
        let w = 0;
        for (let i = 0; i < S; i++)
          for (let j = 0; j < S; j++) {
            sampleVndf(v[0]!, v[1]!, v[2]!, alpha, (i + 0.5) / S, (j + 0.5) / S, h);
            const vh = v[0]! * h[0]! + v[2]! * h[2]!;
            const lz = 2 * vh * h[2]! - v[2]!;
            if (lz > 0) w += (1 + smithLambda(mu, a2)) / (1 + smithLambda(mu, a2) + smithLambda(lz, a2));
          }
        expect(w / (S * S), `α ${String(alpha)} μ ${String(mu)}`).toBeCloseTo(albedoByQuadrature(mu, alpha), 2);
      }
  });

  it('tabulates that albedo, A + B for F = 1 and F₀·A + B for Schlick’s F', () => {
    const ab = new Float64Array(2);
    for (const rough of [0.2, 0.5, 0.9])
      for (const mu of [0.25, 0.5, 1]) {
        lobeAlbedo(mu, rough, ab);
        expect(ab[0]! + ab[1]!, `r ${String(rough)} μ ${String(mu)}`).toBeCloseTo(albedoByQuadrature(mu, alphaOf(rough)), 1);
        expect(ab[0]).toBeGreaterThan(0);
        expect(ab[1]).toBeGreaterThanOrEqual(0);
      }
    // A mirror loses nothing to a second bounce. The roughest lobe (α = 1: D = 1/π) seen face on
    // keeps ∫₀¹ c/(1 + c) dc = 1 − ln 2 of the light: the rest would bounce off another facet.
    lobeAlbedo(1, 0, ab);
    expect(ab[0]! + ab[1]!).toBeGreaterThan(0.99);
    lobeAlbedo(1, 1, ab);
    expect(ab[0]! + ab[1]!).toBeCloseTo(1 - Math.LN2, 2);
  });

  it('puts back what a single bounce loses: a white metal reflects everything it is lit by', () => {
    const ab = new Float64Array(2);
    for (const rough of [0, 0.3, 0.6, 1])
      for (const mu of [0.2, 0.7, 1]) {
        lobeAlbedo(mu, rough, ab);
        const e = ab[0]! + ab[1]!;
        // F₀ = 1: (A + B)(1 + (1 − E)/E) = 1.
        expect((ab[0]! + ab[1]!) * (1 + (1 - e) / e)).toBeCloseTo(1, 9);
      }
  });

  it('Schlick’s Fresnel: F₀ face on, 1 edge on', () => {
    expect(schlick(1, 0.04)).toBeCloseTo(0.04, 12);
    expect(schlick(0, 0.04)).toBeCloseTo(1, 12);
    expect(schlick(0.5, 0.04)).toBeGreaterThan(0.04);
  });
});

describe('Fresnel glass (brdf.ts)', () => {
  it('a dielectric face: ((n − 1)/(n + 1))² face on, nothing of p-polarized light at Brewster’s angle, all of it edge on', () => {
    expect(fresnelDielectric(1, 1.5)).toBeCloseTo(0.04, 12);
    expect(fresnelDielectric(1, 1.33)).toBeCloseTo((0.33 / 2.33) ** 2, 12);
    const brewster = Math.atan(1.5);
    const ci = Math.cos(brewster);
    const ct = Math.sqrt(1 - (Math.sin(brewster) / 1.5) ** 2);
    const rs = ((ci - 1.5 * ct) / (ci + 1.5 * ct)) ** 2;
    expect(fresnelDielectric(ci, 1.5)).toBeCloseTo(rs / 2, 12);
    expect(fresnelDielectric(1e-6, 1.5)).toBeGreaterThan(0.999);
    // Rising with the angle, and Schlick's fit of it close until near grazing.
    let last = 0;
    for (let deg = 0; deg <= 75; deg += 5) {
      const c = Math.cos((deg * Math.PI) / 180);
      const f = fresnelDielectric(c, GLASS_IOR);
      expect(f).toBeGreaterThanOrEqual(last - 1e-12);
      expect(Math.abs(f - schlick(c, 0.04))).toBeLessThan(0.02);
      last = f;
    }
  });

  it('a thin pane: what it lets through face on is what glass.ts says, and nothing is made of light', () => {
    const t = new Float64Array(3);
    const r = new Float64Array(3);
    const a = new Float64Array(3);
    for (const colour of [[0.8, 0.85, 0.82], [0.5, 0.4, 0.3], [1, 1, 1]] as const) {
      const pane = paneTransmission(colour);
      paneAbsorption(pane, GLASS_IOR, a);
      thinPane(a, 1, GLASS_IOR, t, r);
      for (let k = 0; k < 3; k++) expect(t[k]).toBeCloseTo(Math.min(pane[k]!, (1 - 0.04) / (1 + 0.04)), 6);
      for (const deg of [0, 30, 60, 75, 89]) {
        thinPane(a, Math.cos((deg * Math.PI) / 180), GLASS_IOR, t, r);
        for (let k = 0; k < 3; k++) {
          expect(t[k]! + r[k]!).toBeLessThanOrEqual(1 + 1e-12);
          expect(t[k]).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('follows the shared rule (glass.ts, FLR-T-13.17) as the angle grows, from both faces of the pane', () => {
    const t = new Float64Array(3);
    const r = new Float64Array(3);
    const a = new Float64Array(3);
    const shared = new Float64Array(3);
    const pane = paneTransmission([0.88, 0.92, 0.9]);
    paneAbsorption(pane, GLASS_IOR, a);
    for (const deg of [0, 20, 40, 60, 70]) {
      const c = Math.cos((deg * Math.PI) / 180);
      thinPane(a, c, GLASS_IOR, t, r);
      const face = glassAt(pane, c, shared);
      for (let k = 0; k < 3; k++) expect(Math.abs(t[k]! - shared[k]!), `${String(deg)}°`).toBeLessThan(0.04);
      // Both faces reflect: about twice the one face the shared rule counts, never less.
      expect(lum(r)).toBeGreaterThan(face);
      expect(lum(r)).toBeLessThan(2.5 * face);
    }
    // Clear glass, edge on, is a mirror.
    thinPane(a, 0.01, GLASS_IOR, t, r);
    expect(lum(r)).toBeGreaterThan(0.85);
  });
});

/** A camera looking down `dir` at the origin from `distance` metres. */
const looking = (dir: [number, number, number], distance: number, fovY = 10): Camera => ({
  eye: [-dir[0] * distance, -dir[1] * distance, -dir[2] * distance],
  target: [0, 0, 0],
  up: Math.abs(dir[1]) > 0.99 ? [0, 0, -1] : [0, 1, 0],
  fovY,
  near: 0.01,
  label: 'test',
});
const quad = (y: number, r: number): number[] => [-r, y, r, r, y, r, r, y, -r, -r, y, r, r, y, -r, -r, y, -r];

/** A scene of triangles in the given materials, each triangle's material by its index. */
function sceneOf(positions: number[], materials: PtMaterial[], materialOf: (tri: number) => number): PtScene {
  const count = positions.length / 9;
  const normals = new Float64Array(3 * count);
  for (let t = 0; t < count; t++) {
    const p = positions.slice(9 * t, 9 * t + 9);
    const u = [p[3]! - p[0]!, p[4]! - p[1]!, p[5]! - p[2]!];
    const v = [p[6]! - p[0]!, p[7]! - p[1]!, p[8]! - p[2]!];
    const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    const l = Math.hypot(...n);
    normals.set(n.map((x) => x / l), 3 * t);
  }
  return { count, positions: Float64Array.from(positions), normals, material: Int32Array.from({ length: count }, (_, t) => materialOf(t)), uvs: new Float32Array(6 * count).fill(NaN), materials };
}

const centre = (img: Float32Array, w: number, r = 2): [number, number, number] => {
  const s: [number, number, number] = [0, 0, 0];
  let n = 0;
  for (let y = w / 2 - r; y < w / 2 + r; y++)
    for (let x = w / 2 - r; x < w / 2 + r; x++) {
      for (let c = 0; c < 3; c++) s[c] = s[c]! + img[3 * (y * w + x) + c]!;
      n++;
    }
  return [s[0] / n, s[1] / n, s[2] / n];
};

describe('the tracer’s gloss and metal', () => {
  const low: Sun = { dir: [Math.SQRT1_2, Math.SQRT1_2, 0], irradiance: 5, radius: 0.01, color: [1, 1, 1] };
  const sky = new Float64Array(3);

  it('a mirror shows the sky in its own colour: straight down at it, F₀ times the zenith', async () => {
    const s = sceneOf(quad(0, 1000), [{ rgb: [0.9, 0.85, 0.6], glass: false, metallic: 1, roughness: 0 }], () => 0);
    const { color } = await trace(s, { width: 16, height: 16, samples: 64, camera: looking([0, -1, 0], 10, 2), sun: low, seed: 7 });
    skyRadiance(0, 1, 0, low, sky);
    const got = centre(color, 16);
    for (let c = 0; c < 3; c++) expect(got[c]! / ([0.9, 0.85, 0.6][c]! * sky[c]!)).toBeCloseTo(1, 1);
  });

  it('a metal has no diffuse: rough steel in the sun is its gloss alone, and brass is yellow', async () => {
    const steel = sceneOf(quad(0, 1000), [{ rgb: [0.6, 0.6, 0.6], glass: false, metallic: 1, roughness: 0.5 }], () => 0);
    const paint = sceneOf(quad(0, 1000), [{ rgb: [0.6, 0.6, 0.6], glass: false, metallic: 0, roughness: 1 }], () => 0);
    // Seen from the sun's side, 30° up: its reflection looks away from the sun, at the sky.
    const cam = looking([-0.866, -0.5, 0], 10, 2);
    const a = centre((await trace(steel, { width: 16, height: 16, samples: 64, camera: cam, sun: low, seed: 1 })).color, 16);
    const b = centre((await trace(paint, { width: 16, height: 16, samples: 64, camera: cam, sun: low, seed: 1 })).color, 16);
    // Paint is lit like any diffuse surface; steel, its highlight elsewhere, shows mostly the sky in it.
    expect(lum(b)).toBeGreaterThan(0.3 * 5 * Math.SQRT1_2 * 0.6 / Math.PI);
    expect(lum(a)).toBeLessThan(lum(b));
    // A metal's reflection is tinted by its colour: brass against silver, under the same sky.
    const metal = async (rgb: [number, number, number]): Promise<[number, number, number]> =>
      centre((await trace(sceneOf(quad(0, 1000), [{ rgb, glass: false, metallic: 1, roughness: 0.3 }], () => 0), { width: 16, height: 16, samples: 64, camera: looking([0, -1, 0], 10, 2), sun: low, seed: 1 })).color, 16);
    const brass = await metal([0.95, 0.7, 0.3]);
    const silver = await metal([0.95, 0.95, 0.95]);
    expect(brass[0] / brass[2] / (silver[0] / silver[2])).toBeGreaterThan(2);
    expect(brass[0] / silver[0]).toBeCloseTo(1, 1);
  });

  it('a polished floor shows the sun’s highlight where the sun is mirrored in it, and its diffuse elsewhere', async () => {
    const polished = sceneOf(quad(0, 1000), [{ rgb: [0.5, 0.5, 0.5], glass: false, metallic: 0, roughness: 0.15 }], () => 0);
    const matte = sceneOf(quad(0, 1000), [{ rgb: [0.5, 0.5, 0.5], glass: false, metallic: 0, roughness: 1 }], () => 0);
    // Looking down 45° toward the sun: the sun's mirror direction.
    const toward = looking([Math.SQRT1_2, -Math.SQRT1_2, 0], 10, 2);
    const hi = centre((await trace(polished, { width: 16, height: 16, samples: 64, camera: toward, sun: low, seed: 2 })).color, 16);
    const flat = centre((await trace(matte, { width: 16, height: 16, samples: 64, camera: toward, sun: low, seed: 2 })).color, 16);
    expect(lum(hi)).toBeGreaterThan(5 * lum(flat));
    // Away from it, the gloss takes its share from the diffuse: a little darker than matte, never brighter by much.
    const away = looking([-Math.SQRT1_2, -Math.SQRT1_2, 0], 10, 2);
    const off = centre((await trace(polished, { width: 16, height: 16, samples: 64, camera: away, sun: low, seed: 2 })).color, 16);
    const offMatte = centre((await trace(matte, { width: 16, height: 16, samples: 64, camera: away, sun: low, seed: 2 })).color, 16);
    expect(lum(off) / lum(offMatte)).toBeGreaterThan(0.85);
    expect(lum(off) / lum(offMatte)).toBeLessThan(1.15);
  });

  it('is deterministic for a seed: the same seed the same picture, another seed another', async () => {
    const s = sceneOf([...quad(0, 1000), ...quad(1, 1)], [{ rgb: [0.7, 0.6, 0.5], glass: false, metallic: 0.5, roughness: 0.3 }, { rgb: paneTransmission([0.88, 0.92, 0.9]), glass: true, ior: GLASS_IOR }], (t) => (t < 2 ? 0 : 1));
    const opts = { width: 24, height: 24, samples: 8, camera: looking([0.3, -0.9, 0.3], 8, 30), sun: low };
    const a = await trace(s, { ...opts, seed: 11 });
    const b = await trace(s, { ...opts, seed: 11 });
    const c = await trace(s, { ...opts, seed: 12 });
    expect(Buffer.from(a.color.buffer).equals(Buffer.from(b.color.buffer))).toBe(true);
    expect(Buffer.from(a.color.buffer).equals(Buffer.from(c.color.buffer))).toBe(false);
  });
});

describe('the tracer’s glass', () => {
  it('a pane before a lit wall: the wall times what the pane lets through, plus the sky its face reflects', async () => {
    // A white wall at z = −5 facing +Z, a pane at z = −2 face on to the camera at the origin.
    const wall = [-50, -50, -5, 50, -50, -5, 50, 50, -5, -50, -50, -5, 50, 50, -5, -50, 50, -5];
    const pane = [-1, -1, -2, 1, -1, -2, 1, 1, -2, -1, -1, -2, 1, 1, -2, -1, 1, -2];
    const sun: Sun = { dir: [0, 0.6, 0.8], irradiance: 5, radius: 0.01, color: [1, 1, 1] };
    const glass = paneTransmission([0.88, 0.92, 0.9]);
    const mats: PtMaterial[] = [{ rgb: [0.8, 0.8, 0.8], glass: false }, { rgb: glass, glass: true, ior: GLASS_IOR }];
    const cam: Camera = { eye: [0, 0, 0], target: [0, 0, -1], up: [0, 1, 0], fovY: 4, near: 0.01, label: 'test' };
    const without = centre((await trace(sceneOf(wall, mats, () => 0), { width: 16, height: 16, samples: 256, camera: cam, sun, seed: 3 })).color, 16);
    const through = centre((await trace(sceneOf([...wall, ...pane], mats, (t) => (t < 2 ? 0 : 1)), { width: 16, height: 16, samples: 256, camera: cam, sun, seed: 3 })).color, 16);
    const t = new Float64Array(3);
    const r = new Float64Array(3);
    const a = new Float64Array(3);
    paneAbsorption(glass, GLASS_IOR, a);
    thinPane(a, 1, GLASS_IOR, t, r);
    const sky = new Float64Array(3);
    skyRadiance(0, 0, 1, sun, sky);
    for (let c = 0; c < 3; c++) expect(through[c]! / (t[c]! * without[c]! + r[c]! * sky[c]!)).toBeCloseTo(1, 1);
  });

  it('lets the sun through to the floor by what the pane lets through at the sun’s angle', async () => {
    const sun: Sun = { dir: [0.5, Math.sqrt(0.75), 0], irradiance: 50, radius: 0.005, color: [1, 1, 1] };
    const ground = quad(0, 1000);
    // A horizontal pane 1 m up, over the point straight below the camera, the sun 60° up through it.
    const pane = [-0.5, 1, 1.5, 3.5, 1, 1.5, 3.5, 1, -1.5, -0.5, 1, 1.5, 3.5, 1, -1.5, -0.5, 1, -1.5].map((v, i) => (i % 3 === 0 ? v - 1.5 : v));
    const glass = paneTransmission([0.88, 0.92, 0.9]);
    const mats: PtMaterial[] = [{ rgb: [0.5, 0.5, 0.5], glass: false }, { rgb: glass, glass: true, ior: GLASS_IOR }];
    const cam = looking([0, -1, 0], 0.5, 6);
    const open = centre((await trace(sceneOf(ground, mats, () => 0), { width: 16, height: 16, samples: 64, camera: cam, sun, seed: 4, bounces: 0 })).color, 16);
    const under = centre((await trace(sceneOf([...ground, ...pane], mats, (t) => (t < 2 ? 0 : 1)), { width: 16, height: 16, samples: 64, camera: cam, sun, seed: 4, bounces: 0 })).color, 16);
    const t = new Float64Array(3);
    const r = new Float64Array(3);
    const a = new Float64Array(3);
    paneAbsorption(glass, GLASS_IOR, a);
    thinPane(a, Math.sqrt(0.75), GLASS_IOR, t, r);
    expect(lum(under) / lum(open)).toBeCloseTo(lum(t), 1);
  });
});

describe('the sky presets (FLR-T-13.4) in the tracer', () => {
  const site = { site: { location: { latitude: 33_749_000, longitude: -84_388_000 }, trueNorth: 0 } };
  it.each(SKY_PRESETS.map((p) => [p]))('%s: open ground is lit to what the preset calibrates — L = ρ/π (E_sky + E_direct)', async (preset: SkyPreset) => {
    const r = resolveSky(site, { sky: preset, at: '2026-06-21T13:00-04:00' });
    const e = skyIlluminance(r.light, r.field.maps);
    const sun = directOf(r);
    const s = sceneOf(quad(0, 5000), [{ rgb: [0.5, 0.5, 0.5], glass: false }], () => 0);
    const { color } = await trace(s, { width: 16, height: 16, samples: 128, camera: looking([0, -1, 0], 10, 20), sun, seed: 5, field: { sky: r.field, unit: LUX_PER_UNIT } });
    const direct = r.light.direct === null ? 0 : e.direct * lum(r.light.direct.color);
    const want = (0.5 / Math.PI) * (e.sky + direct) / LUX_PER_UNIT;
    expect(lum(centre(color, 16, 6)) / want).toBeCloseTo(1, 1);
  });
});
