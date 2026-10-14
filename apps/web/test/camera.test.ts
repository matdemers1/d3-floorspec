/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lensTangents, readView, savedViewsOf, viewCamera, UNITS_PER_METRE } from '@floorspec/mesh';
import { readModel } from '../src/editor/model';
import { eyeOf, type Orbit } from '../src/editor/three/camera';
import { DEFAULT_SHOT, ThreeStore } from '../src/editor/three/mode';
import { focalToSlider, frameRect, lensProjection, orbitOfView, shotOfView, sliderToFocal } from '../src/editor/three/shot/lens';
import { atOfClock, clockOfAt, deleteView, nextSavedViewId, renameView, saveNewView, updateView, viewFromState, viewMeta, viewNameProblem } from '../src/editor/three/shot/views';
import { crc32, readStoredZip, storedZip } from '../src/editor/three/shot/zip';

/**
 * FLR-T-13.10: the camera in the editor — the frame fitted in the view, the three.js projection a
 * lens makes (the same field of view and two-point shift a saved view's still has), the view state a
 * saved view is made from and goes back to, the Ops that save one, and the shot list's ZIPs.
 */

const M = UNITS_PER_METRE;
type Json = Record<string, unknown>;
const SHOWCASE = JSON.parse(readFileSync(new URL('../../../packages/mesh/test/fixtures/showcase.floorspec.json', import.meta.url), 'utf8')) as Json;

describe('the frame and the lens', () => {
  it('fits the frame in the view with a margin', () => {
    expect(frameRect(1000, 600, '3:2')).toEqual({ x: 500 - 552 * 0.75, y: 24, width: 828, height: 552 });
    const tall = frameRect(1000, 600, '4:5');
    expect(tall.height).toBe(552);
    expect(tall.width).toBeCloseTo(441.6, 9);
    const wide = frameRect(400, 900, '16:9');
    expect(wide.width).toBe(352);
  });

  it('sets the canvas’s field of view so the frame spans the lens’s', () => {
    const orbit: Orbit = { target: [0, 0, 1.5], azimuth: -Math.PI / 2, elevation: 0, distance: 10 };
    const shot = { ...DEFAULT_SHOT, focalLength: 24, aspect: '3:2' as const };
    const p = lensProjection(orbit, shot, 1000, 600);
    const frame = frameRect(1000, 600, '3:2');
    const tan = Math.tan((p.fov * Math.PI) / 360);
    // Across the frame's height, the lens's: tan(fovY/2) of the frame is the lens's tanY.
    expect(tan * (frame.height / 600)).toBeCloseTo(lensTangents(24, 1.5).tanY, 12);
    expect(p.shift).toBe(0);
  });

  it('looks level under two-point perspective and shifts as a saved view’s still does', () => {
    // From 20 m south, 1.6 m up, at a point 4.6 m up: as @floorspec/mesh's viewCamera makes it.
    const orbit = orbitOfView([0, -20, 1.6], [0, 0, 4.6]);
    expect(eyeOf(orbit).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([0, -20, 1.6]);
    const shot = { ...DEFAULT_SHOT, focalLength: 24, twoPoint: true };
    const p = lensProjection(orbit, shot, 1200, 800);
    expect(p.look[2]).toBeCloseTo(1.6, 9);
    const view = readView('SV1', { name: 'Hero', eye: [0, -20 * M, 1.6 * M], target: [0, 0, 4.6 * M], focalLength: 24, twoPoint: true })!;
    const still = viewCamera(view);
    const frame = frameRect(1200, 800, '3:2');
    // In the frame's half-heights, the still's shift.
    expect((p.shift * 800) / frame.height).toBeCloseTo(still.shift, 9);
  });

  it('maps focal lengths onto the log slider and back', () => {
    expect(focalToSlider(12)).toBe(0);
    expect(focalToSlider(200)).toBeCloseTo(1, 12);
    for (const mm of [16, 24, 35, 50, 85]) expect(sliderToFocal(focalToSlider(mm))).toBe(mm);
  });
});

describe('the camera’s state', () => {
  it('opens with the default lens, and goes back to the free view', () => {
    const three = new ThreeStore(null);
    expect(three.get().shot).toBeNull();
    three.toggleCamera(true);
    expect(three.get().shot).toEqual(DEFAULT_SHOT);
    three.setShot({ focalLength: 50 });
    expect(three.get().shot?.focalLength).toBe(50);
    three.clearShot();
    expect(three.get()).toMatchObject({ shot: null, cameraOpen: false, savedView: null });
  });

  it('reads a saved view’s lens back into the panel', () => {
    const view = readView('SV1', { name: 'K', eye: [0, 0, 0], target: [M, 0, 0], aperture: 'f/4', focus: 3 * M, exposure: -3, aspect: '4:5' })!;
    expect(shotOfView(view)).toEqual({ focalLength: 35, twoPoint: false, aperture: 'f/4', dof: true, focus: 3, exposure: -3, aspect: '4:5', guides: true });
  });

  it('keeps the clock’s date, time and offset in `at`', () => {
    expect(atOfClock({ date: '2026-06-21', minutes: 19 * 60 + 30, offset: -240 })).toBe('2026-06-21T19:30-04:00');
    expect(clockOfAt('2026-06-21T19:30-04:00')).toEqual({ date: '2026-06-21', minutes: 1170, offset: -240 });
    expect(clockOfAt('2026-03-20T10:00')).toEqual({ date: '2026-03-20', minutes: 600, offset: 'auto' });
    expect(clockOfAt('yesterday')).toBeNull();
  });
});

describe('saving a view', () => {
  const model = readModel('showcase', JSON.stringify(SHOWCASE));
  const orbit: Orbit = { target: [2, 3, 1.4], azimuth: Math.PI, elevation: 0.1, distance: 6 };
  const made = viewFromState({
    name: 'Living room',
    orbit,
    origin: [M, M, 0],
    three: { shot: { ...DEFAULT_SHOT, focalLength: 18, twoPoint: true, dof: true, aperture: 'f/2.8', focus: 4.2, exposure: 3 }, levels: 'cutaway', lights: false, scene: { id: null, name: 'All on' } },
    level: 'L1',
    sun: { sky: 'clear', clock: { date: '2026-06-21', minutes: 17 * 60, offset: -240 } },
    sceneUnchanged: false,
  });

  it('makes the view the person is looking at, in exact lengths', () => {
    expect(made.target).toEqual([3 * M, 4 * M, Math.round(1.4 * M)]);
    expect(made.eye).toEqual(eyeOf(orbit).map((v, i) => Math.round((v + [1, 1, 0][i]!) * M)));
    expect(made).toMatchObject({ focalLength: 18, twoPoint: true, aperture: 'f/2.8', focus: Math.round(4.2 * M), exposure: 3, level: 'L1', levels: 'cutaway', sky: 'clear', at: '2026-06-21T17:00-04:00', lights: 'off' });
  });

  it('saves it as a new view, declaring FS_views, and the document reads it back', () => {
    const { id, batch } = saveNewView(model, made);
    expect(id).toBe('SV1');
    expect(batch[0]).toEqual({ op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_views', value: '0.1.0' });
    expect(batch[1]).toMatchObject({ op: 'setProperty', id: '$document', path: '/extensions/FS_views/views/SV1' });
    const doc = structuredClone(SHOWCASE);
    (doc['extensionsUsed'] as Json)['FS_views'] = '0.1.0';
    (doc['extensions'] as Json)['FS_views'] = { views: { SV1: (batch[1] as { value: unknown }).value } };
    const back = savedViewsOf(doc)[0]!;
    expect(back).toEqual({ id: 'SV1', ...made });
    const withOne = readModel('showcase', JSON.stringify(doc));
    expect(nextSavedViewId(withOne)).toBe('SV2');
    expect(viewNameProblem(withOne, 'Living room')).toMatch(/already/);
    expect(viewNameProblem(withOne, 'Kitchen')).toBeNull();
    expect(viewNameProblem(withOne, 'Living room', 'SV1')).toBeNull();
    expect(viewMeta(withOne, back)).toBe('18 mm · 3:2 · two-point · f/2.8 · +0.3 EV · 17:00 Jun 21');
  });

  it('updates, renames and deletes one with an op on $document', () => {
    expect(updateView('SV1', made)[0]).toMatchObject({ op: 'setProperty', path: '/extensions/FS_views/views/SV1' });
    expect(renameView('SV1', 'Lounge')).toEqual([{ op: 'setProperty', id: '$document', path: '/extensions/FS_views/views/SV1/name', value: 'Lounge' }]);
    expect(deleteView('SV1')).toEqual([{ op: 'unsetProperty', id: '$document', path: '/extensions/FS_views/views/SV1' }]);
  });
});

describe('the shot list’s ZIPs', () => {
  it('writes stored ZIPs and reads them back', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    const files = [{ name: '01-front.png', bytes: new Uint8Array([1, 2, 3]) }, { name: '02-back.png', bytes: new Uint8Array([4, 5]) }];
    const back = readStoredZip(storedZip(files));
    expect(back.map((f) => [f.name, [...f.bytes]])).toEqual([['01-front.png', [1, 2, 3]], ['02-back.png', [4, 5]]]);
  });
});
