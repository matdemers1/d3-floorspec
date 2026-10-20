/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
/**
 * FLR-T-14.2: the tour in the browser — where a doorway's hotspot lands on the screen for a view,
 * dragging and turning the phone, and what the "Make a virtual tour" dialog reads from the model:
 * its rooms in the tour's order, the saved views standing in each, and the doorways a choice links.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { yawPitch } from '@floorspec/mesh';
import { doorwaysLinked, tourPlanOf } from '../src/share/tour/make';
import { clampLook, dragged, FOV_MAX, FOV_MIN, fromOrientation, onScreen, PITCH_MAX } from '../src/share/tour/view';

const HOUSE = readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8');
const M = 1_280_000;

describe('the tour viewer’s view', () => {
  const look = { yaw: 30, pitch: 0, fov: 60 };

  it('puts what it looks straight at in the middle of the screen, and nothing behind it', () => {
    const mid = onScreen(look, { yaw: 30, pitch: 0 }, 400, 800)!;
    expect(mid.x).toBeCloseTo(200, 9);
    expect(mid.y).toBeCloseTo(400, 9);
    expect(onScreen(look, { yaw: 210, pitch: 0 }, 400, 800)).toBeNull();
  });

  it('puts a doorway to the right of the line of sight right of the middle, and one below it lower', () => {
    const right = onScreen(look, { yaw: 40, pitch: 0 }, 400, 800)!;
    expect(right.x).toBeGreaterThan(200);
    expect(right.y).toBeCloseTo(400, 6);
    const below = onScreen(look, { yaw: 30, pitch: -20 }, 400, 800)!;
    expect(below.x).toBeCloseTo(200, 6);
    // tan(20°)/tan(30°) of the half-height below the middle.
    expect(below.y).toBeCloseTo(400 + 400 * (Math.tan((20 * Math.PI) / 180) / Math.tan((30 * Math.PI) / 180)), 6);
    // The hotspot the worker computed for a threshold lands where a ray to it would.
    const h = yawPitch([0, 0, 1.6], [1, 3, 0]);
    const at = onScreen({ ...h, fov: 70 }, h, 390, 844)!;
    expect(at.x).toBeCloseTo(195, 9);
    expect(at.y).toBeCloseTo(422, 9);
  });

  it('follows a drag: left turns the view right, up tips it down, by the field of view a screen', () => {
    const d = dragged(look, -100, 0, 600);
    expect(d.yaw).toBeCloseTo(40, 9);
    expect(dragged(look, 0, -300, 600).pitch).toBeCloseTo(-30, 9);
  });

  it('keeps the view within its limits, and the yaw within a turn', () => {
    expect(clampLook({ yaw: 370, pitch: 120, fov: 500 })).toEqual({ yaw: 10, pitch: PITCH_MAX, fov: FOV_MAX });
    expect(clampLook({ yaw: -190, pitch: -120, fov: 1 })).toEqual({ yaw: 170, pitch: -PITCH_MAX, fov: FOV_MIN });
  });

  it('turns with the phone from where it was when turned on', () => {
    const start = { alpha: 100, yaw: 30 };
    expect(fromOrientation(100, 90, start, 70)).toEqual({ yaw: 30, pitch: 0, fov: 70 });
    // Turned 20° to the right (alpha goes down), tipped up 10°.
    expect(fromOrientation(80, 100, start, 70)).toEqual({ yaw: 50, pitch: 10, fov: 70 });
  });
});

describe('making a tour of the Courtyard House', () => {
  it('lists its rooms in the tour’s order — the entry first, then garages, closets and the outdoors, left out', () => {
    const plan = tourPlanOf(HOUSE)!;
    const rooms = plan.rooms.map((r) => [r.name, r.byDefault]);
    expect(rooms[0]).toEqual(['Entry', true]);
    expect(rooms.slice(-4)).toEqual([['Garage', false], ['Pantry', false], ['Primary closet', false], ['Roof deck', false]]);
    expect(plan.rooms.filter((r) => r.byDefault)).toHaveLength(16);
    expect(plan.rooms.find((r) => r.id === 'R17')).toMatchObject({ name: 'Primary bedroom', levelName: 'Upper floor' });
  });

  it('offers the saved views that stand in a room, and counts the doorways a choice links', () => {
    const doc = JSON.parse(HOUSE) as { extensionsUsed: Record<string, string>; extensions: Record<string, unknown> };
    doc.extensionsUsed['FS_views'] = '0.1.0';
    doc.extensions['FS_views'] = { views: { SV4: { name: 'Kitchen', eye: [12.8 * M, 16.2 * M, 1.6 * M], target: [17 * M, 17.5 * M, 0.9 * M], focalLength: 24 }, SV1: { name: 'Lawn', eye: [-14 * M, 8.8 * M, 1.7 * M], target: [10 * M, 8 * M, 2 * M], focalLength: 24 } } };
    const plan = tourPlanOf(JSON.stringify(doc))!;
    expect(plan.rooms.find((r) => r.id === 'R8')?.views).toEqual([{ id: 'SV4', name: 'Kitchen' }]);
    // The lawn's view stands in no room.
    expect(plan.rooms.flatMap((r) => r.views.map((v) => v.id))).toEqual(['SV4']);
    // Entry–great room by the cased opening, great room–kitchen across the open plan; not entry–kitchen.
    expect(doorwaysLinked(plan, new Set(['R5', 'R7', 'R8']))).toBe(2);
    expect(doorwaysLinked(plan, new Set(['R5', 'R8']))).toBe(0);
  });

  it('cannot plan a tour of a model that does not read', () => {
    expect(tourPlanOf('{"floorspec": "0.4"')).toBeNull();
  });
});
