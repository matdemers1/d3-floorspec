/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadMesher, type HouseMesh, type MeshPart } from '@floorspec/mesh';
import { readModel, type EditorModel } from '../src/editor/model';
import { ThreeStore } from '../src/editor/three/mode';
import { AXO_STANDOFF, axoHalfHeight, ThreeController, type CameraLike } from '../src/editor/three/controller';
import { lookOf } from '../src/editor/three/parts';
import { cuttingPlanes, cuts } from '../src/editor/three/section/SectionScene';
import {
  alongAxis,
  boxPlanes,
  CORNERS,
  cornersShown,
  DEFAULT_EXPLODE,
  DEFAULT_SECTION,
  defaultBox,
  defaultPlane,
  ease,
  edgesSeen,
  EXPLODE_MS,
  FACE_AXIS,
  faceAt,
  faceCentre,
  faceDistance,
  facePlane,
  faceRect,
  FACES,
  facesEye,
  flipped,
  kept,
  layerLifts,
  layerOf,
  layersOf,
  levelsKept,
  MIN_SIZE,
  moveCorner,
  moveFace,
  movePlane,
  nudgeFace,
  onLevel,
  PAD,
  planeRect,
  progressAt,
  sectionPlanes,
  snap,
  uprightPlanes,
  type Box,
  type SectionState,
  type Vec3,
} from '../src/editor/three/section/section';

/**
 * FLR-T-14.6: the section box, the section plane and the exploded axonometric without a browser —
 * the planes a box and a plane cut with and what they keep, what dragging and nudging a face does,
 * the caps' rectangles and which way they face, which edges and handles the camera sees, the
 * axonometric camera, and the exploded view's layers, lifts and easing. Then the premise of the caps
 * on a real house (the three suite's fixture): its solids are watertight, so the stencil count the caps
 * are drawn by is never anything but 0 or 1 inside one solid, and is 1 inside a wall cut through.
 */

const HOUSE = readFileSync(new URL('../e2e/fixtures/l-stair-hip-roof.json', import.meta.url), 'utf8');
const BOX: Box = { min: [0, 0, 0], max: [10, 8, 3] };
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe('the section box as clipping planes', () => {
  it('keeps what is inside the box and cuts away what is outside, each face on its own plane', () => {
    const planes = boxPlanes(BOX);
    expect(planes).toHaveLength(6);
    expect(kept(planes, [5, 4, 1.5])).toBe(true);
    expect(kept(planes, [0, 0, 0])).toBe(true);
    expect(kept(planes, [10.01, 4, 1.5])).toBe(false);
    expect(kept(planes, [5, -0.01, 1.5])).toBe(false);
    expect(kept(planes, [5, 4, 3.01])).toBe(false);
    for (const f of FACES) {
      const p = facePlane(f, faceAt(BOX, f));
      const c = faceCentre(BOX, f);
      // On the plane, and its normal pointing into the box (three.js keeps the positive side).
      expect(dot(p.normal, c) + p.constant).toBeCloseTo(0, 12);
      expect(dot(p.normal, sub([5, 4, 1.5], c))).toBeGreaterThan(0);
    }
  });

  it('cuts with six planes for a box, one for a plane, none when off — and the ghost keeps exactly what is cut away', () => {
    const on: SectionState = { ...DEFAULT_SECTION, mode: 'box', box: BOX };
    expect(sectionPlanes(on)).toHaveLength(6);
    expect(sectionPlanes({ ...on, mode: 'plane', plane: { face: 'east', at: 4 } })).toEqual([facePlane('east', 4)]);
    expect(sectionPlanes({ ...on, mode: 'off' })).toEqual([]);
    const planes = boxPlanes(BOX);
    const ghost = planes.map(flipped);
    // three.js's clipIntersection: a fragment is cut only when every plane cuts it — kept when any keeps it.
    const ghostKeeps = (p: Vec3) => ghost.some((g) => dot(g.normal, p) + g.constant >= 0);
    for (const p of [[5, 4, 1.5], [11, 4, 1.5], [5, 4, -1], [-1, -1, -1], [9.99, 7.99, 2.99]] as Vec3[]) {
      const inside = kept(planes, p);
      expect(ghostKeeps(p)).toBe(!inside);
    }
  });

  it('moves a face where it is dragged, never past or within three inches of the face across', () => {
    expect(moveFace(BOX, 'east', 6).max[0]).toBe(6);
    expect(moveFace(BOX, 'east', -4).max[0]).toBeCloseTo(MIN_SIZE, 12);
    expect(moveFace(BOX, 'bottom', 5).min[2]).toBeCloseTo(3 - MIN_SIZE, 12);
    expect(moveFace(BOX, 'west', Number.NaN)).toBe(BOX);
    // Out along the outward normal: the west face's out is west.
    expect(nudgeFace(BOX, 'west', 0.5).min[0]).toBe(-0.5);
    expect(nudgeFace(BOX, 'north', -0.5).max[1]).toBe(7.5);
    expect(snap(1.2345, 0.0127)).toBeCloseTo(97 * 0.0127, 12);
  });

  it('drags a corner across the plan: the two upright faces it joins follow it', () => {
    const c = CORNERS.find((k) => k[0] === 1 && k[1] === -1 && k[2] === 1)!;
    const moved = moveCorner(BOX, c, 7, 2);
    expect(moved.max[0]).toBe(7);
    expect(moved.min[1]).toBe(2);
    expect(moved.max[2]).toBe(3);
  });

  it('reads a drag along a face’s normal from the pointer’s ray, nearest the face’s axis', () => {
    // A ray straight down onto x = 4 meets the east face's axis (y 4, z 1.5) at x 4.
    expect(alongAxis([4, 4, 20], [0, 0, -1], faceCentre(BOX, 'east'), 0)).toBeCloseTo(4, 9);
    // A slanting ray: the closest point along x is where it passes the axis line.
    const at = alongAxis([0, -10, 1.5], [0.6, 1, 0], [10, 4, 1.5], 0);
    expect(at).toBeCloseTo(8.4, 9);
    // Looking along the axis says nothing.
    expect(alongAxis([20, 4, 1.5], [-1, 0, 0], [10, 4, 1.5], 0)).toBeNull();
    expect(onLevel([0, 0, 10], [1, 1, -1], 3)).toEqual([7, 7]);
    expect(onLevel([0, 0, 10], [1, 0, 0], 3)).toBeNull();
    expect(onLevel([0, 0, 10], [0, 0, 1], 3)).toBeNull();
  });

  it('caps each face with its own rectangle, wound to face out of the box', () => {
    for (const f of FACES) {
      const r = faceRect(BOX, f);
      const n = cross(sub(r[1], r[0]), sub(r[2], r[0]));
      const { axis, sign } = FACE_AXIS[f];
      expect(Math.sign(n[axis])).toBe(sign);
      for (const v of r) expect(v[axis]).toBe(faceAt(BOX, f));
    }
    // The plane's rectangle: across the house padded, on the plane.
    const r = planeRect(BOX, { face: 'top', at: 1.2 });
    expect(r.every((v) => v[2] === 1.2)).toBe(true);
    expect(Math.min(...r.map((v) => v[0]))).toBeCloseTo(-PAD, 12);
    expect(Math.max(...r.map((v) => v[1]))).toBeCloseTo(8 + PAD, 12);
    expect(cuts(BOX, facePlane('top', 1.2))).toBe(true);
    expect(cuts(BOX, facePlane('top', 3.5))).toBe(false);
    expect(cuts(BOX, facePlane('west', -1))).toBe(false);
  });

  it('dashes the edges behind the box and hides the corner farthest away, as the frame draws them', () => {
    const eye: Vec3 = [-20, -20, 20];
    expect(FACES.filter((f) => facesEye(BOX, f, eye))).toEqual(['west', 'south', 'top']);
    const edges = edgesSeen(BOX, eye);
    expect(edges).toHaveLength(12);
    // The three edges meeting at the bottom north-east corner are behind it.
    const hidden = edges.filter((e) => e.hidden);
    expect(hidden).toHaveLength(3);
    for (const e of hidden) expect([e.a, e.b].some((p) => p[0] === 10 && p[1] === 8 && p[2] === 0)).toBe(true);
    const shown = cornersShown(BOX, eye);
    expect(shown).toHaveLength(6);
    expect(shown.some((c) => c[0] === 1 && c[1] === 1)).toBe(false);
  });

  it('starts around the selection up its level, or the whole house at the current level, and the plane across the middle', () => {
    const house: Box = { min: [-6, -5, -0.3], max: [6, 5, 7] };
    const band = { bottom: -0.3, top: 2.6 };
    const whole = defaultBox(house, null, band);
    expect(whole.min).toEqual([-6 - PAD, -5 - PAD, -0.3]);
    expect(whole.max).toEqual([6 + PAD, 5 + PAD, 2.6]);
    const kitchen = defaultBox(house, { min: [1, 1, 0], max: [4, 3, 1] }, band);
    expect(kitchen.min[0]).toBeCloseTo(1 - PAD, 12);
    expect(kitchen.max[1]).toBeCloseTo(3 + PAD, 12);
    expect(kitchen.max[2]).toBe(2.6);
    // From the south-west, the plane cuts away the south or west side, through the middle.
    const p = defaultPlane(house, (-3 * Math.PI) / 4);
    expect(['south', 'west']).toContain(p.face);
    expect(p.at).toBe(0);
    expect(defaultPlane(house, 0.1).face).toBe('east');
    expect(movePlane({ face: 'east', at: 0 }, house, 100).at).toBe(6 + PAD);
  });

  it('measures a face from the house’s side, as the tag says it', () => {
    const house: Box = { min: [-6, -5, -0.3], max: [6, 5, 7] };
    expect(faceDistance(house, 'east', 0.5)).toEqual({ metres: 6.5, from: 'W wall' });
    expect(faceDistance(house, 'north', 0)).toEqual({ metres: 5, from: 'S wall' });
    expect(faceDistance(house, 'top', 2.7).metres).toBeCloseTo(3, 12);
  });
});

describe('the exploded axonometric', () => {
  it('lifts each level and the roofs over it apart, bottom up, by the spread', () => {
    expect(layerOf({ kind: 'roof', level: 'L2' })).toBe('roof:L2');
    expect(layerOf({ kind: 'roofGable', level: 'L2' })).toBe('roof:L2');
    expect(layerOf({ kind: 'wall', level: 'L1' })).toBe('level:L1');
    const layers = layersOf([{ id: 'L1' }, { id: 'L2' }], new Set(['L1', 'L2']), true);
    expect(layers.map((l) => l.key)).toEqual(['level:L1', 'roof:L1', 'level:L2', 'roof:L2']);
    expect(layersOf([{ id: 'L1' }, { id: 'L2' }], new Set(['L2']), false).map((l) => l.key)).toEqual(['level:L1', 'level:L2']);
    const lifts = layerLifts(layers, 2.4384);
    expect(lifts.get('level:L1')).toBe(0);
    expect(lifts.get('roof:L2')).toBeCloseTo(3 * 2.4384, 12);
  });

  it('eases in and out, and moves at once under reduced motion', () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeCloseTo(0.5, 12);
    expect(ease(0.1)).toBeLessThan(0.1);
    expect(ease(0.9)).toBeGreaterThan(0.9);
    expect(progressAt(0, 1, 1000, 1000, EXPLODE_MS, false)).toBe(0);
    expect(progressAt(0, 1, 1000, 1000 + EXPLODE_MS / 2, EXPLODE_MS, false)).toBeCloseTo(0.5, 9);
    expect(progressAt(0, 1, 1000, 1000 + EXPLODE_MS * 2, EXPLODE_MS, false)).toBe(1);
    expect(progressAt(1, 0, 1000, 1000, EXPLODE_MS, true)).toBe(0);
  });

  it('keeps the levels a box’s height takes in, and only its upright planes cut a lifted level', () => {
    const levels = [{ id: 'L1', bottom: 0, top: 2.9 }, { id: 'L2', bottom: 3.07, top: 5.9 }];
    expect([...levelsKept(levels, { min: [0, 0, -0.3], max: [5, 5, 2.6] })]).toEqual(['L1']);
    expect([...levelsKept(levels, { min: [0, 0, -0.3], max: [5, 5, 4] })]).toEqual(['L1', 'L2']);
    expect(uprightPlanes(boxPlanes(BOX)).map((p) => p.face)).toEqual(['west', 'east', 'south', 'north']);
    const section: SectionState = { ...DEFAULT_SECTION, mode: 'box', box: BOX };
    const exploded = { ...DEFAULT_EXPLODE, active: true, open: true, apart: true };
    expect(cuttingPlanes(section, DEFAULT_EXPLODE, false)).toHaveLength(6);
    expect(cuttingPlanes(section, DEFAULT_EXPLODE, true)).toHaveLength(0);
    expect(cuttingPlanes(section, exploded, false)).toHaveLength(0);
    expect(cuttingPlanes(section, { ...exploded, keep: true }, false)).toHaveLength(4);
  });

  it('frames the axonometric as the perspective view frames its target, standing far back along the same line', () => {
    const three = new ThreeStore();
    const ctl = new ThreeController(three);
    ctl.size = { width: 800, height: 400 };
    ctl.orbit = { target: [1, 2, 3], azimuth: 0, elevation: 0, distance: 10 };
    const at: number[] = [];
    const cam: CameraLike = {
      position: { set: (x, y, z) => { at.splice(0, 3, x, y, z); } },
      up: { set: () => undefined },
      lookAt: () => undefined,
      updateMatrixWorld: () => undefined,
      updateProjectionMatrix: () => undefined,
      isOrthographicCamera: true,
    };
    ctl.frame(cam, 0.016);
    expect(at).toEqual([1 + AXO_STANDOFF, 2, 3]);
    expect(cam.top).toBeCloseTo(axoHalfHeight(10), 12);
    expect(cam.right).toBeCloseTo(axoHalfHeight(10) * 2, 12);
    expect(cam.bottom).toBe(-(cam.top ?? 0));
  });

  it('opens the exploded view over the other panels and lowers the levels before it closes', () => {
    const three = new ThreeStore();
    three.set({ sectionOpen: true, cameraOpen: true });
    three.toggleExplode(true);
    expect(three.get().explode).toMatchObject({ active: true, open: true, apart: true });
    expect(three.get().sectionOpen).toBe(false);
    expect(three.get().cameraOpen).toBe(false);
    three.toggleExplode(false);
    // Still showing while the levels come down; SectionScene leaves it once they are.
    expect(three.get().explode).toMatchObject({ active: true, open: false, apart: false });
    three.setSection({ mode: 'box', box: BOX });
    expect(three.get().section.mode).toBe('box');
  });
});

/** Möller–Trumbore: the distance along the ray to a triangle, or null. */
function hit(o: Vec3, d: Vec3, a: Vec3, b: Vec3, c: Vec3): number | null {
  const e1 = sub(b, a);
  const e2 = sub(c, a);
  const p = cross(d, e2);
  const det = dot(e1, p);
  if (Math.abs(det) < 1e-12) return null;
  const t = sub(o, a);
  const u = dot(t, p) / det;
  if (u < 0 || u > 1) return null;
  const q = cross(t, e1);
  const v = dot(d, q) / det;
  if (v < 0 || u + v > 1) return null;
  const s = dot(e2, q) / det;
  return s > 1e-9 ? s : null;
}

describe('the caps’ premise on a real house', () => {
  let model: EditorModel;
  let mesh: HouseMesh;
  let solids: MeshPart[];

  beforeAll(async () => {
    model = readModel('fixture', HOUSE);
    const mesher = await loadMesher();
    mesh = mesher.meshDerived(model.document, model.derived!);
    solids = mesh.parts.filter((p) => p.closed && ['solid', 'floor', 'ceiling'].includes(lookOf(p)) && p.state !== 'open');
  });

  /**
   * What the stencil holds where a ray from `o` along `d` crosses the plane: each solid's back faces
   * counted up and its front faces down, past the plane — what three.js's IncrementWrap/DecrementWrap
   * leave, the cap drawn where it is not zero.
   */
  function count(o: Vec3, d: Vec3): number {
    let n = 0;
    for (const part of solids) {
      const { positions: P, indices: I } = part.mesh;
      for (let i = 0; i < I.length; i += 3) {
        const v = (k: number): Vec3 => [P[3 * (I[i + k] ?? 0)] ?? 0, P[3 * (I[i + k] ?? 0) + 1] ?? 0, P[3 * (I[i + k] ?? 0) + 2] ?? 0];
        const a = v(0);
        const b = v(1);
        const c = v(2);
        if (hit(o, d, a, b, c) === null) continue;
        n += dot(cross(sub(b, a), sub(c, a)), d) > 0 ? 1 : -1;
      }
    }
    return n;
  }

  it('meshes every wall, floor and roof the caps count as a watertight solid', () => {
    expect(solids.length).toBeGreaterThan(10);
    expect(solids.some((p) => p.kind === 'wall')).toBe(true);
  });

  it('counts 1 where a cut passes through a wall and 0 in a room’s air — never anything else', () => {
    const k = mesh.unitsPerMetre;
    const o = mesh.origin;
    const level = model.levels[0]!;
    const wall = level.walls[0]!;
    // Halfway along the first wall, on its location line, a metre up: inside the wall.
    const mid: Vec3 = [((wall.a[0] + wall.b[0]) / 2 - o[0]) / k, ((wall.a[1] + wall.b[1]) / 2 - o[1]) / k, (level.elevation - o[2]) / k + 1];
    // A plane through it cut from above: the ray goes down from the cut into what the plane keeps.
    expect(count(mid, [0.0123, 0.0071, -1])).toBe(1);
    // A grid of points on a horizontal cut a metre above the first level's floor: the stencil holds
    // 0 or 1 everywhere (watertight, nothing doubled), and 1 at some (walls) and 0 at others (rooms).
    const box = mesh.bbox!;
    const seen = new Set<number>();
    for (let i = 1; i < 12; i++)
      for (let j = 1; j < 12; j++) {
        const x = ((box.min[0] + ((box.max[0] - box.min[0]) * i) / 12) - o[0]) / k;
        const y = ((box.min[1] + ((box.max[1] - box.min[1]) * j) / 12) - o[1]) / k;
        seen.add(count([x, y, mid[2]], [0.0123, 0.0071, -1]));
      }
    expect([...seen].every((n) => n === 0 || n === 1)).toBe(true);
    expect(seen.has(0)).toBe(true);
  });
});
