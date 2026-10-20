/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadMesher, type HouseMesh } from '@floorspec/mesh';
import { readModel, type EditorModel } from '../src/editor/model';
import { buildWorld, type World } from '../src/editor/three/walk';
import { aim, arcPoints, castPath, headsetBrowser, levelAt, levelTarget, moveRig, rayPoints, rigPose, SNAP, startOf, stickTurn, teleportCheck, throughWall, toHouse, turnRig, type Rig, type Vec3 } from '../src/editor/three/xr/xr';

/**
 * FLR-T-14.3: walking the house in VR — where a teleport may land (a room's floor or a stair's step,
 * never through a wall, never up a whole storey, never where a person does not fit), what an arc or
 * a pointer's ray meets first, which level someone is on and where a level switch puts them, and the
 * rig that places the headset's space in the house: standing on the floor, turned on the spot, moved
 * so the head lands on the target.
 *
 * The house is the e2e suite's two-level fixture: a kitchen and a living room joined by a door, an L
 * stair in the living room rising to a loft, a bedroom beside the loft.
 */

const HOUSE = readFileSync(new URL('../e2e/fixtures/l-stair-hip-roof.json', import.meta.url), 'utf8');
let model: EditorModel;
let mesh: HouseMesh;
let world: World;

beforeAll(async () => {
  model = readModel('fixture', HOUSE);
  mesh = (await loadMesher()).meshDerived(model.document, model.derived!);
  world = buildWorld(model, mesh);
});

const kitchen = { x: 6, y: 3, feet: 0 };
const landing = { x: 3, y: 0.6, feet: 1.35 };

describe('a teleport lands', () => {
  it('on a room’s floor and a stair’s landing, from where the person stands', () => {
    const k = teleportCheck(world, { x: 5.95, y: 0.7, feet: 0 }, { x: 6, y: 3, z: 0 });
    expect(k).toMatchObject({ ok: true, x: 6, y: 3, floor: 0 });
    if (k.ok) expect(k.surface).toMatchObject({ kind: 'floor', id: 'KIT' });
    // Up to the L stair's landing from the living room: a step, 1.35 m up.
    const l = teleportCheck(world, { x: 2, y: 3, feet: 0 }, { x: 3, y: 0.6, z: 1.35 });
    expect(l.ok).toBe(true);
    if (l.ok) expect(l.surface).toMatchObject({ kind: 'step', id: 'ST1' });
    expect(l.floor).toBeCloseTo(1.35, 2);
    // And from the landing up to the loft.
    expect(teleportCheck(world, landing, { x: 2, y: 3, z: 2.7 }).ok).toBe(true);
  });

  it('through a door, never through a wall', () => {
    // The kitchen's west wall has a door at its north end; a straight line across the plan further south meets the wall.
    expect(teleportCheck(world, { x: 6, y: 4, feet: 0 }, { x: 2, y: 4, z: 0 }).ok).toBe(true);
    expect(teleportCheck(world, { x: 6, y: 2, feet: 0 }, { x: 2, y: 2, z: 0 })).toMatchObject({ ok: false, reason: 'through-a-wall' });
    expect(throughWall(world, { x: 6, y: 2, feet: 0 }, { x: 2, y: 2, feet: 0 })).toBe('GEF');
    expect(throughWall(world, { x: 6, y: 4, feet: 0 }, { x: 2, y: 4, feet: 0 })).toBeNull();
    // A window is no way through: the kitchen's east window, from inside to the lawn.
    expect(throughWall(world, { x: 6.5, y: 2.6, feet: 0 }, { x: 8, y: 2.6, feet: 0 })).toBe('GCD');
  });

  it('not off the floors, not up a whole storey, not on furniture, not where a person does not fit', () => {
    // The lawn outside: no floor.
    expect(teleportCheck(world, kitchen, { x: 8.5, y: 3, z: 0 })).toMatchObject({ ok: false, reason: 'not-a-floor' });
    // Aimed half a metre above the floor (a bed's top, a counter): not the floor.
    expect(teleportCheck(world, kitchen, { x: 6, y: 3, z: 0.5 })).toMatchObject({ ok: false, reason: 'not-a-floor' });
    // The loft, 2.7 m above the living room: take the stair, or switch level.
    expect(teleportCheck(world, { x: 2, y: 3, feet: 0 }, { x: 2, y: 3.5, z: 2.7 })).toMatchObject({ ok: false, reason: 'too-high' });
    // Hard against the kitchen's west wall: no room to stand.
    expect(teleportCheck(world, kitchen, { x: 4.33, y: 2, z: 0 })).toMatchObject({ ok: false, reason: 'no-room' });
  });
});

describe('aiming', () => {
  it('a pointer’s ray stops at the first floor, wall or ceiling it meets', () => {
    const down = castPath(world, rayPoints([6, 1, 1.6], [0, 1, -0.8]));
    expect(down.kind).toBe('floor');
    expect(down.at![2]).toBe(0);
    expect(down.at![1]).toBeCloseTo(3, 1);
    const west = castPath(world, rayPoints([6, 2, 1.6], [-1, 0, 0]));
    expect(west.kind).toBe('wall');
    expect(west.at![0]).toBeGreaterThan(4.1);
    expect(west.at![0]).toBeLessThan(4.3);
    // Down through the door into the living room.
    const door = castPath(world, rayPoints([6, 4, 1.6], [2.5 - 6, 0, -1.6]));
    expect(door.kind).toBe('floor');
    expect(door.at![0]).toBeCloseTo(2.5, 1);
    // Straight up from the living room: the loft's floor from below.
    expect(castPath(world, rayPoints([2, 3, 1.6], [0, 0, 1])).kind).toBe('ceiling');
  });

  it('a controller’s arc falls on a floor ahead and says whether it may land there', () => {
    const arc = arcPoints([6, 1, 1.2], [0, 1, -0.3], world.base);
    expect(arc.length).toBeGreaterThan(5);
    // A parabola: down at the end, and further along than it started.
    expect(arc[arc.length - 1]![2]).toBeLessThan(arc[1]![2]);
    const { path, check } = aim(world, { x: 6, y: 1, feet: 0 }, [6, 1, 1.2], [0, 1, -0.3], true);
    expect(path.kind).toBe('floor');
    expect(check.ok).toBe(true);
    expect(check.y).toBeGreaterThan(1.5);
    expect(check.y).toBeLessThan(5.3);
    // Into the wall: no teleport, and why.
    expect(aim(world, kitchen, [6, 3, 1.4], [-1, 0, 0.05], false).check).toMatchObject({ ok: false, reason: 'a-wall' });
  });
});

describe('levels', () => {
  it('knows the level under the feet: a stair’s landing is its level’s until the next floor', () => {
    expect(levelAt(world, kitchen)).toBe('L1');
    expect(levelAt(world, landing)).toBe('L1');
    expect(levelAt(world, { x: 2, y: 3, feet: 2.7 })).toBe('L2');
  });

  it('switches level straight up or down where there is a floor, else to the nearest room of that level', () => {
    expect(levelTarget(world, 'L2', { x: 6, y: 3 })).toEqual({ x: 6, y: 3, floor: 2.7, room: 'BED' });
    expect(levelTarget(world, 'L1', { x: 2, y: 3 })).toMatchObject({ x: 2, y: 3, floor: 0, room: 'LIV' });
    // Over the wall between the loft and the bedroom: the bedroom's middle, the nearer room.
    const t = levelTarget(world, 'L2', { x: 4.8, y: 3 })!;
    expect(t.room).toBe('BED');
    expect(t.x).toBeCloseTo(5.975, 3);
    expect(levelTarget(world, 'NOPE', { x: 1, y: 1 })).toBeNull();
  });

  it('starts where the walkthrough starts, or in the middle of a chosen room', () => {
    expect(startOf(world, model, mesh, null, null)).toMatchObject({ x: 5.95, y: 0.7, floor: 0 });
    const loft = startOf(world, model, mesh, 'LOFT', null)!;
    expect(loft.floor).toBe(2.7);
    expect(levelAt(world, { x: loft.x, y: loft.y, feet: loft.floor })).toBe('L2');
  });
});

describe('the rig', () => {
  const rig: Rig = { x: 1, y: 2, floor: 0, yaw: 0, lift: 0 };
  const close = (a: Vec3, b: Vec3) => { a.forEach((v, i) => { expect(v).toBeCloseTo(b[i]!, 9); }); };

  it('stands the headset’s space on the floor, y up made z up, ahead made the heading', () => {
    close(toHouse(rig, [0, 1.6, 0]), [1, 2, 1.6]);
    // Ahead (−z) is east at a heading of 0, north at a quarter turn.
    close(toHouse(rig, [0, 0, -1]), [2, 2, 0]);
    close(toHouse({ ...rig, yaw: Math.PI / 2 }, [0, 0, -1]), [1, 3, 0]);
    // Right (+x) is south when facing east.
    close(toHouse(rig, [1, 0, 0]), [1, 1, 0]);
    // A seated person's space is lifted, the floor stays the floor.
    close(toHouse({ ...rig, floor: 2.7, lift: 0.4 }, [0, 1.2, 0]), [1, 2, 4.3]);
    const q = rigPose(rig).orientation;
    expect(Math.hypot(...q)).toBeCloseTo(1, 12);
  });

  it('turns on the spot about the head, and moves so the head lands on the target', () => {
    const head: Vec3 = [0.3, 1.6, -0.2];
    const h = toHouse(rig, head);
    const turned = turnRig(rig, { x: h[0], y: h[1] }, SNAP);
    const after = toHouse(turned, head);
    expect(after[0]).toBeCloseTo(h[0], 9);
    expect(after[1]).toBeCloseTo(h[1], 9);
    expect(turned.yaw).toBeCloseTo(SNAP, 12);
    const moved = moveRig(turned, { x: after[0], y: after[1] }, { x: 6, y: 3, floor: 2.7 });
    close(toHouse(moved, head), [6, 3, 4.3]);
  });

  it('snaps 30° a push of the stick, and turns smoothly when snap turning is off', () => {
    expect(stickTurn(0.9, true, true, 0.016)).toEqual({ delta: -SNAP, armed: false });
    expect(stickTurn(0.9, false, true, 0.016)).toEqual({ delta: 0, armed: false });
    expect(stickTurn(0.1, false, true, 0.016)).toEqual({ delta: 0, armed: true });
    expect(stickTurn(-0.9, true, true, 0.016).delta).toBe(SNAP);
    expect(stickTurn(1, true, false, 0.5).delta).toBeCloseTo(-Math.PI / 4, 12);
  });

  it('names the headset’s browser for the ready line', () => {
    expect(headsetBrowser('Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/35.0 Chrome/128.0 VR Safari/537.36')).toBe('Quest browser');
    expect(headsetBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15')).toBe('Vision Pro Safari');
    expect(headsetBrowser('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36')).toBe('Chrome');
  });
});
