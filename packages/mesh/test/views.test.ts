/**
 * FLR-T-13.10: saved views (FS_views 0.1.0, FLR-ADR-046) — reading them with their defaults, finding
 * one by name, and the camera every renderer makes of one: the 35 mm lens across the long side, the
 * two-point lens shift, the thin lens and the exposure factor.
 */
import { describe, expect, it } from 'vitest';
import { describeLens, exposureFactor, fieldAcross, focalForField, lensTangents, nextViewId, pictureSize, readView, savedViewNamed, savedViewsOf, toUnits, UNITS_PER_METRE, viewCamera, viewRecord, type SavedView } from '../src/index.js';

const M = UNITS_PER_METRE;

function docWith(views: Record<string, unknown>, declared = true): object {
  return { floorspec: '0.4', project: { name: 'T' }, extensionsUsed: declared ? { FS_views: '0.1.0' } : {}, extensions: { FS_views: { views } } };
}

const hero = { name: 'Hero exterior', eye: [0, -20 * M, 1.6 * M], target: [0, 0, 4.6 * M], focalLength: 24, twoPoint: true, sky: 'clear', at: '2026-06-21T19:30' };

describe('saved views', () => {
  it('reads a view with its defaults filled in', () => {
    const v = readView('SV1', { name: 'Kitchen', eye: [1, 2, 3], target: [4, 5, 6] })!;
    expect(v).toEqual({ id: 'SV1', name: 'Kitchen', eye: [1, 2, 3], target: [4, 5, 6], focalLength: 35, twoPoint: false, aspect: '3:2', exposure: 0, levels: 'cutaway', sky: 'clear', lights: 'off' });
    // A scene turns the lights on; a focus without an aperture is not read.
    const lit = readView('SV2', { name: 'Dusk', eye: [0, 0, 0], target: [1, 0, 0], scene: 'LS1', focus: 99 })!;
    expect(lit.lights).toBe('on');
    expect(lit.focus).toBeUndefined();
    expect(readView('SV3', { name: 'No target', eye: [0, 0, 0] })).toBeUndefined();
  });

  it('lists a document’s views in ID order, and none when it does not declare FS_views', () => {
    const doc = docWith({ SV2: { ...hero, name: 'B' }, SV1: hero, SV10: { ...hero, name: 'C' } });
    expect(savedViewsOf(doc).map((v) => v.id)).toEqual(['SV1', 'SV10', 'SV2']);
    expect(savedViewsOf(docWith({ SV1: hero }, false))).toEqual([]);
  });

  it('finds a view by ID, by name, and by name in any case', () => {
    const doc = docWith({ SV1: hero, SV2: { ...hero, name: 'Great room' } });
    expect(savedViewNamed(doc, 'SV2')?.name).toBe('Great room');
    expect(savedViewNamed(doc, 'Great room')?.id).toBe('SV2');
    expect(savedViewNamed(doc, ' great ROOM ')?.id).toBe('SV2');
    expect(savedViewNamed(doc, 'Garden')).toBeUndefined();
  });
});

describe('the lens', () => {
  it('spans 36 mm across the long side, landscape or portrait', () => {
    expect(fieldAcross(24)).toBeCloseTo(73.74, 1);
    expect(fieldAcross(50)).toBeCloseTo(39.6, 1);
    expect(focalForField(fieldAcross(28))).toBeCloseTo(28, 9);
    const wide = lensTangents(24, 3 / 2);
    expect(wide.tanX).toBeCloseTo(0.75, 12);
    expect(wide.tanY).toBeCloseTo(0.5, 12);
    const tall = lensTangents(24, 4 / 5);
    expect(tall.tanY).toBeCloseTo(0.75, 12);
    expect(tall.tanX).toBeCloseTo(0.6, 12);
  });

  it('sizes a picture by its long side and frame', () => {
    expect(pictureSize(1440, '3:2')).toEqual([1440, 960]);
    expect(pictureSize(1440, '16:9')).toEqual([1440, 810]);
    expect(pictureSize(1440, '4:5')).toEqual([1152, 1440]);
    expect(pictureSize(1440, '1:1')).toEqual([1440, 1440]);
  });

  it('says what it is in words', () => {
    expect(describeLens({ focalLength: 24, aspect: '3:2', twoPoint: true, aperture: 'f/8', exposure: 3 })).toBe('24 mm · 3:2 · two-point · f/8 · +0.3 EV');
    expect(describeLens({ focalLength: 50, aspect: '1:1', twoPoint: false, exposure: -10 })).toBe('50 mm · 1:1 · −1.0 EV');
  });
});

describe('the camera of a view', () => {
  const v = (patch: Partial<SavedView>): SavedView => ({ ...readView('SV1', hero)!, ...patch });

  it('holds a two-point view level and shifts its lens so the target stays in the middle', () => {
    const cam = viewCamera(v({}));
    expect(cam.eye).toEqual([0, -20, 1.6]);
    // Looking level: the line of sight's point is at the eye's height.
    expect(cam.look).toEqual([0, 0, 1.6]);
    const { tanY } = lensTangents(24, 3 / 2);
    // The target, 3 m up 20 m away, projects to (3 / 20) / tanY half-heights above the middle — the shift.
    expect(cam.shift).toBeCloseTo(3 / 20 / tanY, 12);
    expect(cam.fovY).toBeCloseTo((2 * Math.atan(tanY) * 180) / Math.PI, 12);
    expect(cam.lens).toBeNull();
    expect(cam.exposure).toBe(1);
  });

  it('tilts a view that is not two-point, and one looking straight down', () => {
    expect(viewCamera(v({ twoPoint: false })).shift).toBe(0);
    expect(viewCamera(v({ twoPoint: false })).look).toEqual([0, 0, 4.6]);
    const down = viewCamera(v({ eye: [0, 0, 30 * M], target: [0, 0, 0] }));
    expect(down.shift).toBe(0);
  });

  it('is a thin lens of the focal length at its f-number, focused at the target unless told', () => {
    const cam = viewCamera(v({ aperture: 'f/2', twoPoint: false }));
    expect(cam.lens!.radius).toBeCloseTo(0.024 / 2 / 2, 12);
    expect(cam.lens!.focus).toBeCloseTo(Math.hypot(20, 3), 9);
    // Two-point: the plane in focus is across the level line of sight, through the target.
    expect(viewCamera(v({ aperture: 'f/2' })).lens!.focus).toBeCloseTo(20, 9);
    expect(viewCamera(v({ aperture: 'f/8', focus: 5 * M })).lens!.focus).toBeCloseTo(5, 12);
  });

  it('turns tenths of a stop into an exposure factor', () => {
    expect(exposureFactor(10)).toBe(2);
    expect(exposureFactor(-20)).toBe(0.25);
    expect(viewCamera(v({ exposure: 5 })).exposure).toBeCloseTo(Math.SQRT2, 12);
  });

  it('subtracts an origin, as the editor’s mesh is built about one', () => {
    expect(viewCamera(v({}), [1, 2, 0.5]).eye).toEqual([-1, -22, 1.1]);
  });
});

describe('writing a view', () => {
  it('keeps only what differs from the defaults', () => {
    const view = readView('SV1', { name: 'Plain', eye: [0, 0, 0], target: [M, 0, 0] })!;
    expect(viewRecord(view)).toEqual({ name: 'Plain', eye: [0, 0, 0], target: [M, 0, 0] });
    const rich = readView('SV2', { ...hero, aperture: 'f/4', focus: 12 * M, exposure: -3, level: 'L1', levels: 'only', scene: 'LS1', aspect: '4:5', sky: 'dusk' })!;
    expect(viewRecord(rich)).toEqual({ ...hero, aperture: 'f/4', focus: 12 * M, exposure: -3, level: 'L1', levels: 'only', scene: 'LS1', aspect: '4:5', sky: 'dusk' });
  });

  it('rounds metres to exact base units, about an origin', () => {
    expect(toUnits([1.5, -2, 0.0000004], [1, 1, 0])).toEqual([3_200_000, -1_280_000, 1]);
  });

  it('mints the next free view ID', () => {
    const taken = new Set(['SV1', 'SV2', 'SV4']);
    expect(nextViewId((id) => taken.has(id))).toBe('SV3');
  });
});
