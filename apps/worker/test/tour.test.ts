/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_EYE_HEIGHT, directionOf, equirectUv, UNITS_PER_METRE, yawPitch } from '@floorspec/mesh';
import { buildScene, type SceneObstacle, type SceneRoom } from '../src/export/gltf/scene.js';
import { decodeTexture } from '../src/pathtrace/textures.js';
import { tourParams } from '../src/queue/handlers.js';
import { basisOf, encodeJpeg, FACES, faceFov, hotspotsOf, linksOf, planFrame, renderTour, resample, TourStopped, visualCentre } from '../src/tour/index.js';
import { toScene } from '../src/tour/pano.js';

/**
 * FLR-T-14.2: a virtual tour on the worker — the JPEG every panorama is written as, the cube faces
 * resampled into the equirectangular projection, where each room's eye stands and which doorways link
 * the rooms, and a tiny tour of the Courtyard House rendered whole: its panoramas, hotspots, plans and
 * manifest, the same bytes each time, and stopped at once when it is cancelled.
 */

type Json = Record<string, unknown>;
const HOUSE = (): Json => JSON.parse(readFileSync(new URL('./fixtures/courtyard-house.json', import.meta.url), 'utf8')) as Json;
const M = UNITS_PER_METRE;

describe('the JPEG a panorama is written as', () => {
  it('decodes to the picture it was made from, and the same pixels make the same bytes', () => {
    const [w, h] = [96, 40];
    const rgb = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = 3 * (y * w + x);
        rgb[i] = Math.round((x / w) * 255);
        rgb[i + 1] = Math.round((y / h) * 255);
        rgb[i + 2] = 128;
      }
    const jpeg = encodeJpeg(rgb, w, h, 90);
    expect([...jpeg.subarray(0, 4)]).toEqual([0xff, 0xd8, 0xff, 0xe0]);
    expect([...jpeg.subarray(-2)]).toEqual([0xff, 0xd9]);
    expect(encodeJpeg(rgb, w, h, 90)).toEqual(jpeg);
    const back = decodeTexture(jpeg, 'image/jpeg', 'linear')!;
    expect([back.width, back.height]).toEqual([w, h]);
    let worst = 0;
    for (let i = 0; i < w * h * 3; i++) worst = Math.max(worst, Math.abs(back.data[i]! * 255 - rgb[i]!));
    // A smooth picture survives 4:2:0 at quality 90 to within a few levels.
    expect(worst).toBeLessThan(12);
    expect(() => encodeJpeg(rgb, w, h + 1)).toThrow(RangeError);
  });
});

describe('the cube faces, resampled', () => {
  it('turns each face the way the tracer looks through it', () => {
    for (const face of FACES) {
      const b = basisOf(face);
      const dot = (a: readonly number[], c: readonly number[]) => a[0]! * c[0]! + a[1]! * c[1]! + a[2]! * c[2]!;
      expect(Math.abs(dot(b.right, b.forward))).toBeLessThan(1e-12);
      expect(Math.abs(dot(b.up, b.forward))).toBeLessThan(1e-12);
    }
    // A pixel's margin either side: the inner n pixels span exactly 90°.
    expect(Math.tan(((faceFov(100) / 2) * Math.PI) / 180)).toBeCloseTo(1.02, 12);
  });

  it('puts every direction of the panorama where the faces saw it', () => {
    // Each face painted with the direction its pixels look along (x, y, z of the scene, as colour).
    const n = 32;
    const W = n + 2;
    const k = (n + 2) / n;
    const faces = FACES.map((face) => {
      const b = basisOf(face);
      const img = new Float32Array(W * W * 3);
      for (let py = 0; py < W; py++)
        for (let px = 0; px < W; px++) {
          const fx = (((px + 0.5) / W) * 2 - 1) * k;
          const fy = (1 - ((py + 0.5) / W) * 2) * k;
          const d = [0, 1, 2].map((c) => b.right[c]! * fx + b.up[c]! * fy + b.forward[c]!);
          const l = Math.hypot(d[0]!, d[1]!, d[2]!);
          for (let c = 0; c < 3; c++) img[3 * (py * W + px) + c] = d[c]! / l;
        }
      return img;
    });
    const width = 128;
    const equi = resample(faces, n, width);
    let worst = 0;
    for (let j = 0; j < width / 2; j += 3)
      for (let i = 0; i < width; i += 5) {
        const yaw = ((i + 0.5) / width) * 360 - 180;
        const pitch = (0.5 - (j + 0.5) / (width / 2)) * 180;
        const s = toScene(directionOf({ yaw, pitch }));
        for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(equi[3 * (j * width + i) + c]! - s[c]!));
      }
    expect(worst).toBeLessThan(0.03);
    // North in the middle of the picture, east a quarter right of it.
    const at = (u: number, v: number) => Array.from(equi.subarray(3 * (Math.floor(v * (width / 2)) * width + Math.floor(u * width)), 3 * (Math.floor(v * (width / 2)) * width + Math.floor(u * width)) + 3));
    const north = at(...equirectUv({ yaw: 0, pitch: 0 }));
    expect(north[2]).toBeLessThan(-0.99);
    const east = at(...equirectUv({ yaw: 90, pitch: 0 }));
    expect(east[0]).toBeGreaterThan(0.99);
  });
});

describe('where a panorama stands and what it links to', () => {
  const room: SceneRoom = { id: 'R1', name: 'Den', level: 'L1', outer: [[0, 0], [6, 0], [6, 4], [0, 4]], floor: 0, ceiling: 2.7 };
  const box = (id: string, x0: number, y0: number, x1: number, y1: number, top = 0.8, bottom = 0): SceneObstacle => ({ id, level: 'L1', extension: 'FS_furniture', collection: 'furniture', footprint: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], bottom, top });

  it('stands at the middle of an empty room', () => {
    expect(visualCentre(room, [], 1.6)).toEqual([3, 2]);
  });

  it('steps the least it must to keep clear of a table in the middle, but not of a rug or a lamp above the eye', () => {
    const at = visualCentre(room, [box('T1', 2.5, 1.5, 3.5, 2.5)], 1.6);
    const clear = Math.max(Math.abs(at[0] - 3) - 0.5, Math.abs(at[1] - 2) - 0.5);
    expect(clear).toBeGreaterThanOrEqual(0.3 - 1e-9);
    expect(Math.hypot(at[0] - 3, at[1] - 2)).toBeLessThan(1);
    const rug = { ...box('RUG', 1, 1, 5, 3, 0.01), decor: true as const };
    expect(visualCentre(room, [rug, box('PENDANT', 2.8, 1.8, 3.2, 2.2, 2.6, 2.2)], 1.6)).toEqual([3, 2]);
  });

  it('links the Courtyard House’s great room to the entry by its cased opening and to the kitchen across the open plan', async () => {
    const scene = await buildScene(HOUSE(), { doors: 'open' });
    const toured = new Set(['R5', 'R7', 'R8']);
    const links = linksOf(scene, toured);
    const pairs = links.map((l) => [[l.a, l.b].sort().join('|'), l.passage.kind]);
    expect(pairs).toContainEqual(['R5|R7', 'opening']);
    expect(pairs).toContainEqual(['R7|R8', 'separator']);
    // Nothing to a room not toured.
    expect(links.every((l) => toured.has(l.a) && toured.has(l.b))).toBe(true);
    const great = scene.rooms.find((r) => r.id === 'R7')!;
    const eye = [13, 10, 1.6] as const;
    const hotspots = hotspotsOf(great, eye, links, ['R5', 'R7', 'R8'].map((id) => scene.rooms.find((r) => r.id === id)!));
    expect(hotspots.map((h) => [h.to, h.label])).toEqual([['R5', 'Entry'], ['R8', 'Kitchen']]);
    // Each points at its threshold, on the great room's floor.
    for (const h of hotspots) {
      const d = yawPitch(eye, h.at);
      expect(h.yaw).toBeCloseTo(d.yaw, 3);
      expect(h.pitch).toBeCloseTo(d.pitch, 3);
      expect(h.pitch).toBeLessThan(0);
      expect(h.at[2]).toBe(great.floor);
    }
  });
});

describe('a tour, rendered', () => {
  it('makes a panorama of each room, its hotspots, each level’s plans and the manifest — the same each time', async () => {
    const doc = HOUSE();
    (doc['extensionsUsed'] as Json)['FS_views'] = '0.1.0';
    (doc['extensions'] as Json)['FS_views'] = { views: { SV4: { name: 'Kitchen', eye: [12.5 * M, 12.6 * M, 1.6 * M], target: [17 * M, 17.5 * M, 0.9 * M], focalLength: 24 } } };
    const progress: string[] = [];
    const tour = () => renderTour(doc, { rooms: [{ room: 'Entry' }, { room: 'R7' }, { room: 'kitchen', view: 'Kitchen' }], at: '2026-06-21T15:00', face: 12, samples: 1, version: { hash: 'h'.repeat(64), seq: 4 }, onPano: (p) => { progress.push(`${String(p.pano)}/${String(p.panos)}:${String(p.face)}`); } });
    const r = await tour();
    const m = r.manifest;
    expect(m).toMatchObject({ tour: 1, project: 'Courtyard House', start: 'R5', width: 48, height: 24, quality: 'standard', samples: 1, eyeHeight: DEFAULT_EYE_HEIGHT, light: { sky: 'clear', at: '2026-06-21T15:00' }, version: { hash: 'h'.repeat(64), seq: 4 } });
    expect(m.rooms.map((x) => [x.id, x.name, x.pano])).toEqual([['R5', 'Entry', 'pano-01-r5.jpg'], ['R7', 'Great room', 'pano-02-r7.jpg'], ['R8', 'Kitchen', 'pano-03-r8.jpg']]);
    // The kitchen stands where its saved view does, first looking along it.
    expect(m.rooms[2]!.stands).toEqual({ at: 'view', view: 'Kitchen' });
    expect(m.rooms[2]!.eye).toEqual([12.5, 12.6, 1.6]);
    expect(m.rooms[2]!.heading).toBeCloseTo(yawPitch([12.5, 12.6, 1.6], [17, 17.5, 1.6]).yaw, 3);
    // The others at eye height, inside their rooms.
    expect(m.rooms[0]!.stands).toEqual({ at: 'centre' });
    expect(m.rooms[0]!.eye[2]).toBeCloseTo(DEFAULT_EYE_HEIGHT / M, 4);
    expect(m.rooms[1]!.hotspots.map((h) => h.label)).toEqual(['Entry', 'Kitchen']);
    expect(m.rooms[0]!.hotspots.map((h) => h.label)).toEqual(['Great room']);
    // Every face of every panorama said so, in order.
    expect(progress.filter((p, i) => p !== progress[i - 1])).toEqual(['1/3:1', '1/3:2', '1/3:3', '1/3:4', '1/3:5', '1/3:6', '2/3:1', '2/3:2', '2/3:3', '2/3:4', '2/3:5', '2/3:6', '3/3:1', '3/3:2', '3/3:3', '3/3:4', '3/3:5', '3/3:6']);
    // The panoramas are JPEGs of the panorama's size; the plans SVGs of the main floor, in both themes.
    const files = new Map(r.files.map((f) => [f.path, f]));
    for (const room of m.rooms) {
      const jpeg = files.get(room.pano)!;
      expect(jpeg.contentType).toBe('image/jpeg');
      const pic = decodeTexture(jpeg.bytes, 'image/jpeg')!;
      expect([pic.width, pic.height]).toEqual([48, 24]);
    }
    expect(m.levels.map((l) => [l.id, l.name, l.plan.light, l.plan.dark])).toEqual([['L1', 'Main floor', 'plan-l1-light.svg', 'plan-l1-dark.svg']]);
    const svg = new TextDecoder().decode(files.get('plan-l1-light.svg')!.bytes);
    // The map's frame puts a room's corners where the plan draws them.
    const scene = await buildScene(doc);
    const kitchen = scene.rooms.find((x) => x.id === 'R8')!;
    const f = planFrame(svg, kitchen)!;
    expect(f).toEqual(m.levels[0]!.plan.frame);
    const drawn = /<path data-id="R8"[^>]*? d="M([-\d.]+) ([-\d.]+)L([-\d.]+) ([-\d.]+)/.exec(svg)!;
    const [x, y] = kitchen.outer[1]!;
    expect(f.x0 + f.s * x).toBeCloseTo(Number(drawn[3]), 1);
    expect(f.y0 - f.s * y).toBeCloseTo(Number(drawn[4]), 1);
    // Seeded: the same tour again is the same bytes.
    const again = await tour();
    expect(again.files.map((x) => x.bytes)).toEqual(r.files.map((x) => x.bytes));
  }, 120_000);

  it('stops at once when it is cancelled, and refuses rooms and views the model lacks', async () => {
    const stop = new AbortController();
    stop.abort();
    await expect(renderTour(HOUSE(), { rooms: [{ room: 'R5' }], at: '2026-06-21T15:00', face: 8, samples: 1, signal: stop.signal })).rejects.toBeInstanceOf(TourStopped);
    await expect(renderTour(HOUSE(), { rooms: [{ room: 'Ballroom' }], at: '2026-06-21T15:00', face: 8, samples: 1 })).rejects.toThrow(/no room Ballroom/);
    await expect(renderTour(HOUSE(), { rooms: [{ room: 'R5', view: 'Garden' }], at: '2026-06-21T15:00', face: 8, samples: 1 })).rejects.toThrow(/no saved view "Garden"/);
  }, 60_000);

  it('reads a tour job’s parameters as the api writes them', () => {
    expect(tourParams({ rooms: [{ room: 'R5' }, { room: 'R8', view: 'SV4' }, { nope: 1 }], size: 'small', quality: 'draft', eyeHeight: 1_950_720, at: '2026-06-21T15:00', versionSeq: 7 })).toEqual({
      rooms: [{ room: 'R5' }, { room: 'R8', view: 'SV4' }],
      size: 'small',
      quality: 'draft',
      eyeHeight: 1_950_720,
      at: '2026-06-21T15:00',
      versionSeq: 7,
    });
    const d = tourParams({ size: 'huge', eyeHeight: 3, at: 'noon' });
    expect(d).toMatchObject({ size: 'large', quality: 'standard', eyeHeight: DEFAULT_EYE_HEIGHT, versionSeq: null });
    expect(d.at).toMatch(/^\d{4}-06-21T15:00$/);
    expect(d.rooms).toBeUndefined();
  });
});
