/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { glareZones, WORK_PLANE } from '@floorspec/analysis';
import { architecture, daylightStudy, DaylightProbe, fieldSky } from '../src/pathtrace/daylight.js';
import { paneAbsorption, thinPane } from '../src/pathtrace/brdf.js';
import { buildScene } from '../src/export/gltf/scene.js';
import { Rng } from '../src/pathtrace/rng.js';
import { resolveSky } from '../src/pathtrace/sky.js';
import type { PtScene } from '../src/pathtrace/trace.js';

/**
 * FLR-T-14.7: daylight on the work plane, checked by hand on a room with one window — the sun patch
 * where geometry puts it and as bright as the sun's altitude and the glass say, the sky through an
 * opening as bright as its view factor says — and on the Courtyard House: the den and the primary
 * bedroom on a June and a December afternoon, their desks and beds, deterministic.
 */

type V = [number, number, number];
const GLASS: V = [0.9, 0.9, 0.9];

/** Two triangles over a rectangle from a corner along two edges. */
const rect = (o: V, a: V, b: V): number[] => {
  const p = (s: number, t: number): number[] => [o[0] + a[0] * s + b[0] * t, o[1] + a[1] * s + b[1] * t, o[2] + a[2] * s + b[2] * t];
  return [...p(0, 0), ...p(1, 0), ...p(1, 1), ...p(0, 0), ...p(1, 1), ...p(0, 1)];
};

function scene(parts: { tris: number[]; material: number }[], materials: PtScene['materials']): PtScene {
  const positions = parts.flatMap((p) => p.tris);
  const material = parts.flatMap((p) => new Array<number>(p.tris.length / 9).fill(p.material));
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
  return { count, positions: Float64Array.from(positions), normals, material: Int32Array.from(material), uvs: new Float32Array(6 * count).fill(NaN), materials };
}

/**
 * A room 4 m square and 3 m high, in the tracer's frame (+Y up, −Z north): x 0–4, z −4–0, its south
 * wall at z = 0 with a window 2 m wide and 1 m high (x 1–3, y 1–2) — glazed, or an open hole.
 * Its surfaces are black (the least reflectance the gather allows), so what reaches a point is
 * almost all straight from the sun and the sky.
 */
function box(glazed: boolean): PtScene {
  const wall = 0;
  const glass = 1;
  const parts = [
    { tris: rect([0, 0, 0], [4, 0, 0], [0, 0, -4]), material: wall }, // floor
    { tris: rect([0, 3, 0], [0, 0, -4], [4, 0, 0]), material: wall }, // ceiling
    { tris: rect([0, 0, -4], [4, 0, 0], [0, 3, 0]), material: wall }, // north
    { tris: rect([0, 0, 0], [0, 0, -4], [0, 3, 0]), material: wall }, // west
    { tris: rect([4, 0, 0], [0, 0, -4], [0, 3, 0]), material: wall }, // east
    // The south wall around its window.
    { tris: rect([0, 0, 0], [4, 0, 0], [0, 1, 0]), material: wall },
    { tris: rect([0, 2, 0], [4, 0, 0], [0, 1, 0]), material: wall },
    { tris: rect([0, 1, 0], [1, 0, 0], [0, 1, 0]), material: wall },
    { tris: rect([3, 1, 0], [1, 0, 0], [0, 1, 0]), material: wall },
    ...(glazed ? [{ tris: rect([1, 1, 0], [2, 0, 0], [0, 1, 0]), material: glass }] : []),
  ];
  return scene(parts, [
    { rgb: [0, 0, 0], glass: false },
    { rgb: GLASS, glass: true },
  ]);
}

/** What a clear pane lets straight through at `cos`, luminance. */
function pane(cos: number): number {
  const a = new Float64Array(3);
  const t = new Float64Array(3);
  const r = new Float64Array(3);
  paneAbsorption(GLASS, 1.5, a);
  thinPane(a, cos, 1.5, t, r);
  return 0.2126 * t[0]! + 0.7152 * t[1]! + 0.0722 * t[2]!;
}

/**
 * The irradiance (lux) on an upward-facing point at `p` from a sky of uniform luminance `L` seen
 * through the window: ∫ L τ(θ₂) cos θ₁ cos θ₂ / r² dA over the opening, by a fine midpoint rule.
 */
function throughWindow(p: V, L: number, glazed: boolean): number {
  const n = 400;
  let e = 0;
  const dA = (2 / n) * (1 / n);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const x = 1 + ((i + 0.5) * 2) / n;
      const y = 1 + (j + 0.5) / n;
      const dx = x - p[0];
      const dy = y - p[1];
      const dz = 0 - p[2];
      const r2 = dx * dx + dy * dy + dz * dz;
      const r = Math.sqrt(r2);
      const cos1 = dy / r;
      const cos2 = dz / r;
      e += (L * (glazed ? pane(cos2) : 1) * cos1 * cos2 * dA) / r2;
    }
  return e;
}

describe('a room with one window, by hand', () => {
  const RAD = Math.PI / 180;
  const sun = { dir: [0, Math.sin(45 * RAD), Math.cos(45 * RAD)] as V, lux: 100_000 };

  it("puts the sun patch where the window's geometry does, as bright as sin(altitude) and the glass say", () => {
    const probe = new DaylightProbe({ pt: box(true), sky: () => 0 });
    // From (2, 0.762, −0.7) the sun's ray (south, 45° up) meets the wall at y = 0.762 + 0.7 = 1.462: in the window.
    const inPatch = sun.lux * sun.dir[1] * probe.transmit(2, WORK_PLANE, -0.7, ...sun.dir);
    expect(inPatch).toBeCloseTo(sun.lux * Math.sin(45 * RAD) * pane(Math.cos(45 * RAD)), 6);
    expect(inPatch / (sun.lux * Math.sin(45 * RAD))).toBeGreaterThan(0.8);
    // From 2 m in, it meets the wall at 2.762 m: above the window's head, in the wall's shadow.
    expect(probe.transmit(2, WORK_PLANE, -2, ...sun.dir)).toBe(0);
    // And from beside the window's jamb (x = 0.5, the ray straight south): the wall again.
    expect(probe.transmit(0.5, WORK_PLANE, -0.7, ...sun.dir)).toBe(0);
  });

  it('under open sky, a point sees πL', () => {
    // One small triangle far below, so the BVH has something: every path escapes.
    const pt = scene([{ tris: rect([100, -50, 100], [1, 0, 0], [0, 0, 1]), material: 0 }], [{ rgb: [0.5, 0.5, 0.5], glass: false }]);
    const probe = new DaylightProbe({ pt, sky: () => 1000 });
    expect(probe.gather(0, 0, 0, 64, new Rng(1), null)).toBeCloseTo(Math.PI * 1000, 6);
  });

  for (const glazed of [false, true]) {
    it(`through ${glazed ? 'a glazed window' : 'an open window'}, the sky as its view factor says`, () => {
      const L = 4000;
      const probe = new DaylightProbe({ pt: box(glazed), sky: () => L });
      const p: V = [2, WORK_PLANE, -2];
      const want = throughWindow(p, L, glazed);
      const got = probe.gather(p[0], p[1], p[2], 4096, new Rng(7), null);
      // The black room still reflects 3%: a little over the window's own light.
      expect(got).toBeGreaterThan(want * 0.97);
      expect(got).toBeLessThan(want * 1.08);
    });
  }

  it('is the same every time for a seed', () => {
    const probe = new DaylightProbe({ pt: box(true), sky: () => 3000 });
    const a = probe.gather(2, WORK_PLANE, -1, 64, new Rng(42), sun);
    const b = probe.gather(2, WORK_PLANE, -1, 64, new Rng(42), sun);
    expect(a).toBe(b);
  });

  it('a white room bounces more light to the point than a black one', () => {
    const black = new DaylightProbe({ pt: box(true), sky: () => 4000 });
    const white = new DaylightProbe({ pt: { ...box(true), materials: [{ rgb: [0.8, 0.8, 0.8], glass: false }, { rgb: GLASS, glass: true }] }, sky: () => 4000 });
    const p: V = [2, WORK_PLANE, -3];
    expect(white.gather(...p, 1024, new Rng(3), sun)).toBeGreaterThan(1.5 * black.gather(...p, 1024, new Rng(3), sun));
  });
});

describe('the Courtyard House', () => {
  const doc = JSON.parse(readFileSync(new URL('./fixtures/courtyard-house.json', import.meta.url), 'utf8')) as object;
  const june = daylightStudy(doc, { at: '2026-06-21T15:00-04:00' });
  const december = daylightStudy(doc, { at: '2026-12-21T15:00-05:00' });

  it("its desks' and beds' zones lie on the pieces the scene draws", async () => {
    const scene = await buildScene(doc);
    const zones = glareZones(doc);
    expect(zones.map((z) => z.id)).toEqual(expect.arrayContaining(['DEN-DESK', 'PB-BED']));
    for (const z of zones) {
      const o = scene.obstacles.find((x) => x.id === z.id)!;
      const xs = o.footprint.map((p) => p[0]);
      const ys = o.footprint.map((p) => p[1]);
      for (const [x, y] of z.corners) {
        expect(x).toBeGreaterThanOrEqual(Math.min(...xs) - 1e-6);
        expect(x).toBeLessThanOrEqual(Math.max(...xs) + 1e-6);
        expect(y).toBeGreaterThanOrEqual(Math.min(...ys) - 1e-6);
        expect(y).toBeLessThanOrEqual(Math.max(...ys) + 1e-6);
      }
    }
  });

  it('a June and a December afternoon: the den and the primary bedroom in bands, with sun-hours', async () => {
    for (const s of [await june, await december]) {
      expect(s.levels.map((l) => l.level)).toEqual(['L1', 'L2']);
      for (const id of ['R6', 'R17']) {
        const r = s.rooms.find((x) => x.id === id)!;
        expect(r.cells).toBeGreaterThan(50);
        expect(r.shares.bright + r.shares.useful + r.shares.lamp + r.shares.dim).toBeCloseTo(1, 2);
        expect(r.median).toBeGreaterThan(100);
        expect(r.sunYear).toBeGreaterThan(r.sunToday);
      }
      // A room with no window gets no daylight.
      expect(s.rooms.find((x) => x.id === 'R9')!.median).toBe(0);
      // No roof deck: an exterior room is not studied.
      expect(s.rooms.some((x) => x.id === 'R20')).toBe(false);
    }
    const j = await june;
    const d = await december;
    // The sun is higher in June: more light outside, the same sky model.
    expect(j.outside.sun).toBeGreaterThan(d.outside.sun);
    expect(j.sun!.altitude).toBeGreaterThan(60);
    expect(d.sun!.altitude).toBeLessThan(30);
  });

  it("flags the den's desk and the primary bed when direct sun reaches them, with the hours", async () => {
    for (const s of [await june, await december]) {
      const desk = s.glare.find((g) => g.id === 'DEN-DESK')!;
      const bed = s.glare.find((g) => g.id === 'PB-BED')!;
      expect(desk.roomName).toBe('Den');
      expect(bed.roomName).toBe('Primary bedroom');
      expect(desk.hours.length).toBeGreaterThan(0);
      expect(bed.hours.length).toBeGreaterThan(0);
      // Late afternoon in the primary bedroom: its west windows, the sun low.
      expect(bed.hours.at(-1)!.to).toBeGreaterThan(16 * 60);
      expect(bed.low).toBe(true);
    }
  });

  it('is the same study every time', async () => {
    const again = await daylightStudy(doc, { at: '2026-12-21T15:00-05:00' });
    const first = await december;
    expect(again.levels).toEqual(first.levels);
    expect(again.rooms).toEqual(first.rooms);
    expect(again.glare).toEqual(first.glare);
  });

  it('under an overcast sky: no sun, no glare, less light', async () => {
    const s = await daylightStudy(doc, { at: '2026-06-21T15:00-04:00', sky: 'overcast', year: false });
    expect(s.glare).toEqual([]);
    const den = s.rooms.find((r) => r.id === 'R6')!;
    expect(den.median).toBeLessThan((await june).rooms.find((r) => r.id === 'R6')!.median);
    expect(s.outside.sun).toBe(0);
  });

  it('refuses a time it cannot read and a sky it does not study', async () => {
    await expect(daylightStudy(doc, { at: 'June 21' })).rejects.toThrow(RangeError);
    await expect(daylightStudy(doc, { at: '2026-06-21T15:00', sky: 'night' as 'clear' })).rejects.toThrow(/clear or overcast/);
  });

  it('reads the sky as the stills do', () => {
    const sky = resolveSky(doc, { sky: 'clear', at: '2026-06-21T12:00' });
    const along = fieldSky(sky.field);
    // A blue zenith in cd/m², and the sunlit lawn below the horizon no brighter than a white surface in the same light.
    expect(along(0, 1, 0)).toBeGreaterThan(1000);
    const sun = sky.light.direct!;
    expect(along(0, -1, 0)).toBeGreaterThan(0);
    expect(along(0, -1, 0)).toBeLessThan((sun.lux * sun.dir[2] + 25_000) / Math.PI);
  });

  it('studies the architecture only: no furniture in the way', async () => {
    const scene = await buildScene(doc);
    const all = scene.levels.flatMap((l) => l.nodes).reduce((s, n) => s + n.primitives.reduce((t, p) => t + p.indices.length / 3, 0), 0);
    expect(architecture(scene).count).toBeLessThan(all);
  });
});
