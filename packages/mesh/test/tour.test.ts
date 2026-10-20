/**
 * FLR-T-14.2: a virtual tour — the equirectangular projection every panorama is made in and read
 * by, the direction from a panorama's eye to a doorway (its hotspot), the budget, the eye height and
 * the rooms toured by default.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EYE_HEIGHT,
  directionOf,
  equirectUv,
  equirectYawPitch,
  linkedDoorways,
  tourAt,
  touredByDefault,
  tourFace,
  tourWithinBudget,
  UNITS_PER_METRE,
  wrapYaw,
  yawPitch,
} from '../src/index.js';

const close = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('the equirectangular projection', () => {
  it('puts north in the middle, east a quarter to the right, the zenith on the top row', () => {
    expect(equirectUv({ yaw: 0, pitch: 0 })).toEqual([0.5, 0.5]);
    expect(equirectUv({ yaw: 90, pitch: 0 })).toEqual([0.75, 0.5]);
    expect(equirectUv({ yaw: -90, pitch: 0 })).toEqual([0.25, 0.5]);
    expect(equirectUv({ yaw: 180, pitch: 0 })).toEqual([0, 0.5]);
    expect(equirectUv({ yaw: 0, pitch: 90 })[1]).toBe(0);
    expect(equirectUv({ yaw: 0, pitch: -90 })[1]).toBe(1);
  });

  it('goes from a point of the panorama to its direction and back', () => {
    for (const [u, v] of [[0.1, 0.2], [0.5, 0.5], [0.73, 0.91], [0.999, 0.01]] as const) {
      const [u2, v2] = equirectUv(equirectYawPitch(u, v));
      close(u2, u);
      close(v2, v);
    }
  });

  it('wraps a yaw into (−180°, 180°]', () => {
    expect(wrapYaw(190)).toBe(-170);
    expect(wrapYaw(-180)).toBe(180);
    expect(wrapYaw(540)).toBe(180);
    expect(wrapYaw(-725)).toBe(-5);
  });

  it('gives a unit vector along the direction, in the project frame', () => {
    const east = directionOf({ yaw: 90, pitch: 0 });
    close(east[0], 1);
    close(east[1], 0);
    close(east[2], 0);
    const up = directionOf({ yaw: 33, pitch: 90 });
    close(up[2], 1);
    const d = directionOf({ yaw: -135, pitch: -20 });
    close(Math.hypot(...d), 1);
  });
});

describe('a hotspot’s direction from the eye', () => {
  it('is the yaw clockwise from north and the pitch down to the threshold', () => {
    const eye = [2, 3, 1.6] as const;
    // A doorway 3 m north and 3 m east, on the floor: north-east, looking down.
    const h = yawPitch(eye, [5, 6, 0]);
    close(h.yaw, 45);
    close(h.pitch, (Math.atan2(-1.6, Math.hypot(3, 3)) * 180) / Math.PI);
    // Due west, level.
    close(yawPitch(eye, [-4, 3, 1.6]).yaw, -90);
    // Due south.
    close(yawPitch(eye, [2, -1, 1.6]).yaw, 180);
  });

  it('points where the panorama shows the doorway', () => {
    const eye = [0, 0, 1.6] as const;
    const door = [-2, 1, 0] as const;
    const d = directionOf(yawPitch(eye, door));
    const len = Math.hypot(door[0] - eye[0], door[1] - eye[1], door[2] - eye[2]);
    close(d[0], (door[0] - eye[0]) / len);
    close(d[1], (door[1] - eye[1]) / len);
    close(d[2], (door[2] - eye[2]) / len);
  });
});

describe('what a tour is made at', () => {
  it('keeps every size and quality within a still’s work budget per panorama, but none over', () => {
    expect(tourFace('large')).toBe(1024);
    expect(tourWithinBudget('large', 'high')).toBe(true);
    expect(tourWithinBudget('large', 'standard')).toBe(true);
    expect(tourWithinBudget('small', 'draft')).toBe(true);
  });

  it('stands the eye at 5′-3″, exactly, and sees every room on midsummer’s afternoon', () => {
    expect(DEFAULT_EYE_HEIGHT).toBe(63 * 32_512);
    expect(DEFAULT_EYE_HEIGHT / UNITS_PER_METRE).toBeCloseTo(1.6002, 4);
    expect(tourAt(2026)).toBe('2026-06-21T15:00');
  });

  it('leaves out garages, closets and the outdoors unless asked', () => {
    expect(touredByDefault({ function: 'kitchen', name: 'Kitchen' })).toBe(true);
    expect(touredByDefault({ function: 'garage', name: 'Garage' })).toBe(false);
    expect(touredByDefault({ function: 'storage', name: 'Pantry' })).toBe(false);
    expect(touredByDefault({ function: 'exterior', name: 'Roof deck' })).toBe(false);
    expect(touredByDefault({ function: 'circulation', name: 'Hall closet' })).toBe(false);
    expect(touredByDefault({ name: 'Den' })).toBe(true);
  });

  it('counts each doorway once, though both rooms have a hotspot at it', () => {
    const h = (to: string) => ({ to, label: to, via: 'D', kind: 'door' as const, yaw: 0, pitch: 0, at: [0, 0, 0] as const });
    expect(linkedDoorways({ rooms: [{ id: 'A', hotspots: [h('B'), h('C')] }, { id: 'B', hotspots: [h('A')] }, { id: 'C', hotspots: [h('A')] }] as never })).toBe(2);
  });
});
