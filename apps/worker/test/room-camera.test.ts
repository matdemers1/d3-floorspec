/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildScene, type Scene, type SceneDoor, type SceneObstacle, type SceneRoom } from '../src/export/gltf/index.js';
import { renderSceneStill } from '../src/pathtrace/index.js';
import { CLEARANCE, findRoom, roomCamera, type Camera } from '../src/render3d/camera.js';
import { renderScene } from '../src/render3d/index.js';

/**
 * FLR-T-12.29: a camera standing in a room stands where a person could — never inside a fixture's or
 * a piece of furniture's footprint, nor within 0.3 m of one — and from the clear spot that sees the
 * most of what the room holds: a doorway blocked by a shower is passed over, a filled corner too, and
 * the same model always gives the same camera, in the raster render and the lit one alike.
 */

type Pt = readonly [number, number];
type Json = Record<string, unknown>;

/** The camera's eye on the plan: the scene is (x, z, −y). */
const plan = (c: Camera): [number, number] => [c.eye[0], -c.eye[2]];

function insideRing(p: Pt, ring: readonly Pt[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** How far a point is from a footprint: 0 inside it. */
function distance(p: Pt, ring: readonly Pt[]): number {
  if (insideRing(p, ring)) return 0;
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j]!;
    const [bx, by] = ring[i]!;
    const [dx, dy] = [bx - ax, by - ay];
    const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy));
  }
  return best;
}

const rect = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

const obstacle = (id: string, footprint: [number, number][], collection = 'fixtures', bottom = 0, top = 1): SceneObstacle => ({ id, level: 'L1', extension: 'FS_plumbing', collection, footprint, bottom, top });

/** Every footprint on the room's level at least `CLEARANCE` from the eye, and the eye in the room. */
function expectClear(c: Camera, room: SceneRoom, obstacles: readonly SceneObstacle[]): void {
  const eye = plan(c);
  expect(insideRing(eye, room.outer), `${c.label}: in the room`).toBe(true);
  for (const o of obstacles) if (o.level === room.level) expect(distance(eye, o.footprint), `${c.label}: clear of ${o.id}`).toBeGreaterThanOrEqual(CLEARANCE - 1e-9);
}

// A 3 × 2.5 m bath, its door in the south wall; just inside the door, a shower.
const BATH: SceneRoom = { id: 'R9', name: 'Bath', level: 'L1', outer: rect(0, 0, 3, 2.5), floor: 0, ceiling: 2.4 };
const DOOR: SceneDoor = { id: 'D1', level: 'L1', mid: [0.9, 0], normal: [0, 1], halfThickness: 0.06, sill: 0 };
const SHOWER = obstacle('S1', rect(0.05, 0.05, 1.6, 1.3), 'fixtures', 0, 2);
const TOILET = obstacle('S2', rect(2.3, 1.9, 2.95, 2.45));
const VANITY = obstacle('V1', rect(1.95, 0.05, 2.9, 0.6), 'casework');

describe('a camera standing in a room (FLR-T-12.29)', () => {
  it('stands just inside the doorway when it is clear', () => {
    const c = roomCamera(BATH, [DOOR], [TOILET, VANITY]);
    expect(c.label).toBe('Bath (R9) from its doorway D1');
    expect(plan(c)[0]).toBeCloseTo(0.9, 9);
    expect(plan(c)[1]).toBeCloseTo(0.51, 9);
    expectClear(c, BATH, [TOILET, VANITY]);
  });

  it('passes over a doorway blocked by a shower, and never stands inside a footprint', () => {
    const obstacles = [SHOWER, TOILET, VANITY];
    const c = roomCamera(BATH, [DOOR], obstacles);
    expect(c.label).not.toMatch(/doorway/);
    expect(c.label).toMatch(/^Bath \(R9\) from its (corner|middle)$/);
    expectClear(c, BATH, obstacles);
    // It looks at what the bath holds: the middle of its fixtures, below the eye.
    const [tx, ty] = [c.target[0], -c.target[2]];
    const mids = obstacles.map((o) => [(o.footprint[0]![0] + o.footprint[2]![0]) / 2, (o.footprint[0]![1] + o.footprint[2]![1]) / 2]);
    expect(tx).toBeCloseTo(mids.reduce((s, m) => s + m[0]!, 0) / 3, 9);
    expect(ty).toBeCloseTo(mids.reduce((s, m) => s + m[1]!, 0) / 3, 9);
    expect(c.target[1]).toBeLessThan(c.eye[1]);
  });

  it('keeps out of a filled far corner', () => {
    const room: SceneRoom = { id: 'R4', name: 'Den', level: 'L1', outer: [[0, 0], [4.5, 0], [4.5, 3], [0.5, 3]], floor: 0, ceiling: 2.7 };
    const empty = roomCamera(room, []);
    expect(empty.label).toBe('Den (R4) from its corner');
    // The empty room's camera stands in the corner farthest from the middle; fill that corner.
    const [ex, ey] = plan(empty);
    const corner = room.outer.reduce((best, p) => (Math.hypot(p[0] - ex, p[1] - ey) < Math.hypot(best[0] - ex, best[1] - ey) ? p : best));
    const fill = obstacle('W1', rect(corner[0] - 1.4, corner[1] - 1.4, corner[0] + 1.4, corner[1] + 1.4).map(([x, y]): [number, number] => [Math.max(0, Math.min(4.5, x)), Math.max(0, Math.min(3, y))]), 'pieces', 0, 2.1);
    const sofa = obstacle('W2', rect(1.5, 2.1, 3.3, 2.95), 'pieces');
    const c = roomCamera(room, [], [fill, sofa]);
    expect(c.label).toBe('Den (R4) from its corner');
    expectClear(c, room, [fill, sofa]);
    expect(Math.hypot(plan(c)[0] - corner[0], plan(c)[1] - corner[1])).toBeGreaterThan(1.4);
  });

  it('is deterministic: the same room, doors and contents, in any order, give the same camera', () => {
    const doors = [DOOR, { ...DOOR, id: 'D0', level: 'L2' }];
    const obstacles = [SHOWER, TOILET, VANITY, obstacle('S3', rect(0.2, 2.0, 0.7, 2.45))];
    const a = roomCamera(BATH, doors, obstacles);
    const b = roomCamera(structuredClone(BATH), [...doors].reverse(), [...obstacles].reverse());
    expect(b).toEqual(a);
  });

  it('a room too full to stand in a doorway or a corner is seen from its open floor, still clear', () => {
    const room: SceneRoom = { id: 'R5', level: 'L1', outer: rect(0, 0, 3, 3), floor: 0, ceiling: 2.4 };
    // Everything but a strip down the middle is taken.
    const obstacles = [obstacle('A', rect(0, 0, 1.0, 3)), obstacle('B', rect(2.0, 0, 3, 3)), obstacle('C', rect(1.0, 0, 2.0, 0.6)), obstacle('D', rect(1.0, 2.4, 2.0, 3))];
    const c = roomCamera(room, [], obstacles);
    expectClear(c, room, obstacles);
    expect(Number.isFinite(c.target[0]) && Math.hypot(c.target[0] - c.eye[0], c.target[2] - c.eye[2])).toBeGreaterThan(0.2);
  });
});

describe('a camera standing in the showcase', () => {
  let scene: Scene;
  const showcase = (): Json => JSON.parse(readFileSync(new URL('../../../packages/mesh/test/fixtures/showcase.floorspec.json', import.meta.url), 'utf8')) as Json;
  beforeAll(async () => {
    scene = await buildScene(showcase());
  });

  it('carries every extension element\'s footprint in the scene, by ID', () => {
    const ids = scene.obstacles.map((o) => o.id);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toEqual(expect.arrayContaining(['S4', 'X1', 'X10', 'H1']));
    const tub = scene.obstacles.find((o) => o.id === 'S4')!;
    expect(tub.extension).toBe('FS_plumbing');
    expect(tub.footprint).toHaveLength(4);
    expect(tub.top - tub.bottom).toBeCloseTo(1.9, 2);
  });

  it('stands every room\'s camera clear of everything in it — the laundry\'s out of its shower', () => {
    for (const room of scene.rooms) {
      const c = roomCamera(room, scene.doors, scene.obstacles);
      expectClear(c, room, scene.obstacles);
    }
    const laundry = roomCamera(findRoom(scene.rooms, 'Laundry')!, scene.doors, scene.obstacles);
    expect(distance(plan(laundry), scene.obstacles.find((o) => o.id === 'S4')!.footprint)).toBeGreaterThan(CLEARANCE);
  });

  it('draws the raster and the lit render from the same camera, the same every time', async () => {
    const again = await buildScene(showcase());
    for (const room of scene.rooms) expect(roomCamera(room, again.doors, again.obstacles)).toEqual(roomCamera(room, scene.doors, scene.obstacles));
    const raster = renderScene(scene, { room: 'Laundry', width: 160 });
    expect(raster.camera).toBe(roomCamera(findRoom(scene.rooms, 'Laundry')!, scene.doors, scene.obstacles).label);
    expect(Buffer.from(renderScene(again, { room: 'Laundry', width: 160 }).png).equals(Buffer.from(raster.png))).toBe(true);
    const lit = await renderSceneStill(scene, { room: 'Laundry', pixels: { width: 32, height: 24 }, samples: 1, denoise: false });
    expect(lit.camera).toBe(raster.camera);
  });
});
