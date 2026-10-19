/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apply } from '@floorspec/ops';
import { OFFICIAL_READER } from '@floorspec/engine';
import type { Vec3 } from '@floorspec/mesh';
import { readModel, type EditorModel, type Point } from '../src/editor/model';
import type { Batch } from '../src/editor/ops';
import { moveOpening } from '../src/editor/ops';
import { moveDevice } from '../src/editor/systems/ops';
import type { DeviceView } from '../src/editor/systems/view';
import { rigidPreview } from '../src/editor/rigid';
import { carryRiders } from '../src/editor/arrange/carry';
import { SNAP_DEFAULTS } from '../src/editor/snap';
import { dragDevice, dragOpening } from '../src/editor/drag';
import { turnBatch } from '../src/furniture/resize';
import { alongWall, faceDrag, faceOf, lineOf, moveWords, onLevel, onUpright, toMetres, toPlan, type Ray } from '../src/editor/three/edit/project';
import { IDENTITY, moved, motionOfFrames, movesBetween, slideMotion } from '../src/editor/three/edit/motion';
import { chainLength, readingOf, readout, snapOnTriangle, squareEdge, type Corner } from '../src/editor/three/edit/tape';
import { guideWords, hostWords, isEditable } from '../src/editor/three/edit/controller';
import { centroid } from '../src/editor/geometry';

/**
 * FLR-T-14.8, Edit in 3D on the Courtyard House (the worker's fixture): the pointer's ray taken to the
 * host an item moves on — the floor at the height it was grabbed, its wall's face, an opening's
 * wall — and back to the plan; the same drag the plan makes (drag.ts) from it; the motion that draws a
 * rigid preview by moving parts instead of meshing again; the tape's snaps and readout.
 */

const HOUSE = readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8');
const base = readModel('h', HOUSE);
const K = 1_280_000;
const ORIGIN: Vec3 = [15_000_000, 12_000_000, 0];
const dev = (m: EditorModel, id: string): DeviceView => m.levels.flatMap((l) => l.devices).find((d) => d.id === id)!;
const levelOf = (m: EditorModel, id: string) => m.levels.find((l) => l.devices.some((d) => d.id === id) || l.openings.some((o) => o.id === id))!;
const OPTS = { grid: 32_512, tol: 32_512, free: false, settings: SNAP_DEFAULTS, name: (id: string) => id };

function applied(batch: Batch, model: EditorModel = base): EditorModel {
  const r = apply(model.document, { batch: carryRiders(model, batch) }, OFFICIAL_READER);
  if (r.status !== 'committed') throw new Error(`rejected: ${r.diagnostics.map((d) => `${d.code} ${d.message}`).join('; ')}`);
  return readModel('p', r.document);
}

/** A ray from a camera up and to the south-west, through a point of the mesh's frame. */
function rayThrough(p: Vec3): Ray {
  const origin: Vec3 = [p[0] - 8, p[1] - 9, p[2] + 7];
  const d: Vec3 = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
  const l = Math.hypot(...d);
  return { origin, dir: [d[0] / l, d[1] / l, d[2] / l] };
}

const close = (a: readonly number[], b: readonly number[], tol = 1e-6) => a.every((v, i) => Math.abs(v - (b[i] ?? NaN)) <= tol);

describe('from the pointer to the host', () => {
  it('meets the level plane at the height an item was grabbed, and the ray from behind meets nothing', () => {
    const p: Vec3 = [1.25, -3.5, 0.42];
    expect(close(onLevel(rayThrough(p), 0.42)!, p)).toBe(true);
    const away: Ray = { origin: [0, 0, 2], dir: [0, 0, 1] };
    expect(onLevel(away, 0)).toBeNull();
    expect(onLevel({ origin: [0, 0, 2], dir: [1, 0, 0] }, 0)).toBeNull();
  });

  it('meets an upright plane — a wall’s face — and refuses one seen edge on', () => {
    const p: Vec3 = [2, 3, 1.4];
    expect(close(onUpright(rayThrough(p), [2, 0], [1, 0])!, p)).toBe(true);
    expect(onUpright({ origin: [0, 0, 1], dir: [0, 1, 0] }, [2, 0], [1, 0])).toBeNull();
  });

  it('takes a point of the mesh’s frame to the plan and back, to the base unit', () => {
    const plan: Point = [18_726_912, 19_702_272];
    const m = toMetres(plan, 0, ORIGIN, K);
    const back = toPlan(m, ORIGIN, K);
    expect(Math.round(back[0])).toBe(plan[0]);
    expect(Math.round(back[1])).toBe(plan[1]);
  });

  it('puts a wall’s face its thickness off the location line, its normal out of the wall on that side', () => {
    const level = levelOf(base, 'R1-ART1');
    const wall = level.walls.find((w) => w.id === 'W9')!;
    const left = faceOf(wall, 'left', ORIGIN, K);
    const right = faceOf(wall, 'right', ORIGIN, K);
    const line = lineOf(wall, ORIGIN, K);
    // The two faces are the wall's thickness apart, across its normal.
    const across = (left.p[0] - right.p[0]) * line.n[0] + (left.p[1] - right.p[1]) * line.n[1];
    expect(across * K).toBeCloseTo(wall.thickness, -1);
    expect(close(left.n, line.n)).toBe(true);
    expect(close(right.n, [-line.n[0], -line.n[1]])).toBe(true);
    // A point on the line projects onto it at its offset.
    expect(alongWall(wall, [(wall.a[0] + wall.b[0]) / 2, (wall.a[1] + wall.b[1]) / 2])).toBeCloseTo(Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]) / 2, 3);
  });
});

describe('dragging in 3D is the plan’s drag', () => {
  it('moves the armchair on the floor by the pointer’s travel at the height it was grabbed, by the grid, as one moveElement', () => {
    const chair = dev(base, 'GR-CHAIR1');
    const level = levelOf(base, 'GR-CHAIR1');
    // Grabbed on its seat (0.4 m up) — the same plane all the drag long.
    const grabbed = toMetres(chair.placement!.point, 0, ORIGIN, K);
    const z = 0.4;
    const from = toPlan(onLevel(rayThrough([grabbed[0], grabbed[1], z]), z)!, ORIGIN, K);
    // 0.6 m east and 0.25 m north on the screen's ray.
    const to = toPlan(onLevel(rayThrough([grabbed[0] + 0.6, grabbed[1] + 0.25, z]), z)!, ORIGIN, K);
    const r = dragDevice(level, chair, [to[0] - from[0], to[1] - from[1]], { ...OPTS, settings: { ...SNAP_DEFAULTS, guides: false } });
    expect(r.hover).not.toBeNull();
    // By the 1″ grid.
    expect(r.d[0] % 32_512).toBe(0);
    expect(r.d[1] % 32_512).toBe(0);
    expect(Math.abs(r.d[0] - 0.6 * K)).toBeLessThanOrEqual(32_512 / 2);
    const batch = moveDevice(chair.id, r.hover!.host);
    expect(batch).toHaveLength(1);
    const after = applied(batch);
    const p = dev(after, 'GR-CHAIR1').placement!.point;
    expect(p[0] - chair.placement!.point[0]).toBe(r.d[0]);
    expect(p[1] - chair.placement!.point[1]).toBe(r.d[1]);
  });

  it('locks to one axis with Shift, and leaves the grid with Alt', () => {
    const chair = dev(base, 'GR-CHAIR1');
    const level = levelOf(base, 'GR-CHAIR1');
    const locked = dragDevice(level, chair, [0.6 * K, 0.25 * K], { ...OPTS, axis: true, settings: { ...SNAP_DEFAULTS, guides: false } });
    expect(locked.d[1]).toBe(0);
    const free = dragDevice(level, chair, [600_001, 250_003], { ...OPTS, free: true });
    expect(free.d).toEqual([600_001, 250_003]);
  });

  it('lines the armchair up with the sofa by the smart guides, as the plan does', () => {
    const chair = dev(base, 'GR-CHAIR1');
    const level = levelOf(base, 'GR-CHAIR1');
    const sofa = dev(base, 'GR-SOFA');
    // Towards the sofa's line, a little short of it: the guide takes it the rest of the way.
    const sy = Math.max(...sofa.footprint.map((p) => p[1]));
    const cy = Math.max(...chair.footprint.map((p) => p[1]));
    const r = dragDevice(level, chair, [0, sy - cy - 20_000], { ...OPTS, tol: 64_000 });
    expect(r.guide?.label).toBeDefined();
    expect(guideWords(r.guide?.label)).toMatch(/^(Aligned with|Centred on|In line with)/);
  });

  it('moves a picture on its wall face along and up, never off the wall', () => {
    const art = dev(base, 'R1-ART1');
    const level = levelOf(base, 'R1-ART1');
    const wall = level.walls.find((w) => w.id === art.host!['wall'])!;
    const length = Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]);
    const offset = art.host!['offset'] as number;
    const height = art.host!['height'] as number;
    const next = faceDrag({ offset, height, length, along: 0.31 * K, up: 0.1 * K, grid: 32_512, free: false });
    expect((next.offset - offset) % 32_512).toBe(0);
    expect((next.height - height) % 32_512).toBe(0);
    expect(next.height).toBeGreaterThan(height);
    const far = faceDrag({ offset, height, length, along: 100 * K, up: -100 * K, grid: 32_512, free: false });
    expect(far.offset).toBe(Math.floor(length));
    expect(far.height).toBe(0);
    const after = applied(moveDevice(art.id, { mode: 'wallFace', wall: wall.id, side: 'left', at: next.offset, height: next.height }));
    expect(dev(after, 'R1-ART1').host).toMatchObject({ wall: wall.id, side: 'left', offset: next.offset, height: next.height });
    expect(hostWords(base, level, art)).toBe('on Wall W9');
  });

  it('slides a window along its wall to where the pointer took its middle', () => {
    const level = levelOf(base, 'O22');
    const o = level.openings.find((x) => x.id === 'O22')!;
    const wall = level.walls.find((w) => w.id === o.wall)!;
    const length = Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]);
    const t: Point = [(wall.b[0] - wall.a[0]) / length, (wall.b[1] - wall.a[1]) / length];
    const centre: Point = [(o.start[0] + o.end[0]) / 2, (o.start[1] + o.end[1]) / 2];
    const by = 24 * 32_512;
    const r = dragOpening(level, wall, o, [centre[0] + t[0] * by, centre[1] + t[1] * by], { ...OPTS, settings: { ...SNAP_DEFAULTS, guides: false } });
    expect(r.offset).toBe(o.offset + by);
    const after = applied(moveOpening('O22', r.offset));
    expect(levelOf(after, 'O22').openings.find((x) => x.id === 'O22')!.offset).toBe(o.offset + by);
  });

  it('edits items on a host and openings, and nothing else', () => {
    expect(isEditable(base, 'GR-CHAIR1')).toBe(true);
    expect(isEditable(base, 'R1-ART1')).toBe(true);
    expect(isEditable(base, 'O22')).toBe(true);
    expect(isEditable(base, 'W9')).toBe(false);
    expect(isEditable(base, 'R7')).toBe(false);
  });
});

describe('the motion that draws a rigid preview', () => {
  it('moves the island and what rides on it as the preview has them, and nothing else', () => {
    const island = dev(base, 'KIT-ISLAND');
    const [x, y] = island.host!['position'] as [number, number];
    const by = 6 * 32_512;
    const preview = rigidPreview(base, carryRiders(base, moveDevice('KIT-ISLAND', { mode: 'surface', room: 'R8', surface: 'floor', at: [x + by, y - by], rotation: 90_000_000 })))!;
    expect(preview).not.toBeNull();
    const moves = movesBetween(base, preview, ORIGIN, K);
    expect([...moves.keys()].sort()).toEqual(['KIT-COOKTOP', 'KIT-COOKTOP-G', 'KIT-ISLAND', 'R8-BOWL1']);
    // The island's footprint, moved by its motion, is where the preview has it.
    const m = moves.get('KIT-ISLAND')!;
    const a = centroid(island.footprint);
    const b = centroid(dev(preview, 'KIT-ISLAND').footprint);
    const got = moved(m, toMetres(a, 0, ORIGIN, K));
    expect(close(got, toMetres(b, 0, ORIGIN, K), 1e-6)).toBe(true);
  });

  it('turns about the item’s middle when it is turned', () => {
    const chair = dev(base, 'GR-CHAIR1');
    const preview = rigidPreview(base, turnBatch(chair, 45_000_000))!;
    const m = movesBetween(base, preview, ORIGIN, K).get('GR-CHAIR1')!;
    expect(m.turn).toBeCloseTo(Math.PI / 4, 9);
    const mid = toMetres(centroid(chair.footprint), 0, ORIGIN, K);
    expect(close(moved(m, mid), mid, 2e-5)).toBe(true);
  });

  it('agrees with motionOfFrames, and the identity moves nothing', () => {
    const m = motionOfFrames({ point: [0, 0], angle: 0 }, { point: [K, 2 * K], angle: 90_000_000 }, K / 2, [0, 0, 0], K);
    expect(close(moved(m, [1, 0, 0]), [1, 3, 0.5])).toBe(true);
    expect(moved(IDENTITY, [1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('slides an opening moved along a straight wall, and says nothing of one left alone', () => {
    const level = levelOf(base, 'O22');
    const o = level.openings.find((x) => x.id === 'O22')!;
    const wall = level.walls.find((w) => w.id === o.wall)!;
    const after = applied(moveOpening('O22', o.offset + 32_512 * 12));
    const moves = movesBetween(base, after, ORIGIN, K);
    const m = moves.get('O22')!;
    const s = slideMotion(wall, 32_512 * 12, K);
    expect(close(m.t, s.t, 1e-6)).toBe(true);
    expect(moves.has('O21')).toBe(false);
    expect(movesBetween(base, base, ORIGIN, K).size).toBe(0);
  });
});

describe('the tape measure', () => {
  const corner = (world: Vec3, screen: [number, number]): Corner => ({ world, screen });
  const tri: [Corner, Corner, Corner] = [corner([0, 0, 0], [100, 100]), corner([2, 0, 0], [300, 100]), corner([0, 0, 2], [100, -100])];

  it('snaps to a corner within 10 px, then a square edge within 6 px, else the face', () => {
    expect(snapOnTriangle([0.05, 0, 0.05], [105, 96], tri)).toEqual({ at: [0, 0, 0], kind: 'vertex' });
    const e = snapOnTriangle([1, 0, 0.02], [200, 98], tri);
    expect(e.kind).toBe('edge');
    expect(close(e.at, [1, 0, 0])).toBe(true);
    expect(snapOnTriangle([0.5, 0, 0.5], [150, 50], tri)).toEqual({ at: [0.5, 0, 0.5], kind: 'face' });
  });

  it('never snaps to a triangle’s diagonal, which is not an edge of the house', () => {
    expect(squareEdge([2, 0, 0], [0, 0, 2])).toBe(false);
    expect(squareEdge([0, 0, 0], [0, 0, 2])).toBe(true);
    // On the diagonal, 3 px from it: the face, not an edge.
    const p = snapOnTriangle([1, 0, 1], [200, 3], tri);
    expect(p.kind).toBe('face');
  });

  it('reads a length and its Δx, Δy, Δz in feet and inches, and in millimetres', () => {
    const ft = 0.3048;
    const r = readingOf([0, 0, 0], [10 * ft + 2 * 0.0254, -7 * ft, 0]);
    expect(r.dx).toBe(Math.round((10 * ft + 2 * 0.0254) * K));
    expect(r.dz).toBe(0);
    const t = readout(r, 'imperial');
    expect(t.deltas).toBe('Δx 10′-2″ · Δy 7′-0″ · Δz 0″');
    expect(t.length).toMatch(/^12′-4/);
    expect(readout(readingOf([0, 0, 0], [1.5, 0, 0]), 'metric')).toEqual({ length: '1500 mm', deltas: 'Δx 1500 mm · Δy 0 mm · Δz 0 mm' });
    expect(chainLength([[0, 0, 0], [1, 0, 0], [1, 1, 0]])).toBe(2 * K);
  });

  it('says a move in compass words', () => {
    expect(moveWords([2 * 12 * 32_512, -8 * 32_512], (v) => `${String(v / 32_512)}in`)).toBe('24in east, 8in south');
    expect(moveWords([0, 0], String)).toBe('');
  });
});
