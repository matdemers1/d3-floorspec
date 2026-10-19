/**
 * FLR-T-14.1: the editor's film helpers — keyframes appended and retimed clear of their neighbours'
 * holds, a recorded walk thinned, the Ops a film is saved and deleted with (Ops on `$document`'s
 * extras), the ease words between keys, a film camera as the 3D view's orbit, and the sun track's
 * day, dusk and night.
 */
import { describe, expect, it } from 'vitest';
import { EASE_LABELS, UNITS_PER_METRE, type FilmKey } from '@floorspec/mesh';
import { appended, deleteFilm, orbitOfFilm, recordedKey, retimed, saveFilm, segmentWords, thinWalk, trimSeconds, withKey } from '../src/editor/three/film/films';
import { atWords, timelapseBands } from '../src/editor/three/film/light';

const key = (at: number, extra: Partial<FilmKey> = {}): FilmKey => ({ at, ease: 'ease', hold: 0, view: 'SV1', ...extra });
const M = UNITS_PER_METRE;

describe('film keyframes in the editor', () => {
  it('appends a key five seconds after the last one, the first at the start', () => {
    expect(appended(null, { view: 'SV1', ease: 'ease', hold: 0 }).map((k) => k.at)).toEqual([0]);
    expect(appended({ keys: [key(0), key(3000, { hold: 1000 })] }, { view: 'SV2', ease: 'ease', hold: 0 }).map((k) => k.at)).toEqual([0, 3000, 9000]);
  });

  it('retimes a key to the tenth of a second, clear of the hold before it and the key after it', () => {
    const film = { keys: [key(0, { hold: 2000 }), key(5000), key(9000)] };
    expect(retimed(film, 1, 6234)).toBe(6200);
    expect(retimed(film, 1, 500)).toBe(2100);
    expect(retimed(film, 1, 12_000)).toBe(8900);
    expect(retimed(film, 0, -50)).toBe(0);
    expect(withKey(film, 1, key(9500)).map((k) => k.at)).toEqual([0, 9000, 9500]);
  });

  it('saves and deletes a film with an Op on the document’s extras', () => {
    expect(saveFilm('F1', { name: 'Walk-in', keys: [key(0), key(4000, { ease: 'linear', hold: 500 })] })).toEqual([
      { op: 'setProperty', id: '$document', path: '/extras/d3floorspec/films/F1', value: { name: 'Walk-in', keys: [{ at: 0, view: 'SV1' }, { at: 4000, ease: 'linear', hold: 500, view: 'SV1' }] } },
    ]);
    expect(deleteFilm('F1')).toEqual([{ op: 'unsetProperty', id: '$document', path: '/extras/d3floorspec/films/F1' }]);
  });

  it('thins a walk to where it moved or turned, keeping its end', () => {
    const at = (x: number, look = 0) => ({ eye: [x, 0, 1.6] as [number, number, number], target: [x + 3, look, 1.6] as [number, number, number] });
    const kept = thinWalk([at(0), at(0.05), at(0.1), at(0.2), at(0.2, 1), at(0.21, 1), at(0.22, 1)]);
    expect(kept.map((s) => [s.eye[0], s.target[1]])).toEqual([[0, 0], [0.2, 0], [0.2, 1], [0.22, 1]]);
  });

  it('records a camera in base units, whole', () => {
    const k = recordedKey([1, 2, 1.6], [4, 2, 1.5], [10 * M, 0, 0], 24.4, 'Walk 1');
    expect(k).toEqual({ ease: 'linear', hold: 0, eye: [11 * M, 2 * M, 1.6 * M], target: [14 * M, 2 * M, 1.5 * M], focalLength: 24, name: 'Walk 1' });
  });

  it('says the segment between two keys as the board does', () => {
    expect(segmentWords(key(0), key(5000), EASE_LABELS)).toBe('Ease');
    expect(segmentWords(key(0, { hold: 2000 }), key(5000, { ease: 'linear' }), EASE_LABELS)).toBe('Hold 2 s · Linear');
    expect(trimSeconds(2500)).toBe('2.5');
  });

  it('turns a film camera into the 3D view’s orbit about the mesh’s origin', () => {
    const o = orbitOfFilm({ eye: [10 * M, 0, 0], target: [0, 0, 0] }, [0, 0, 0]);
    expect(o.distance).toBeCloseTo(10, 9);
    expect(o.azimuth).toBeCloseTo(0, 9);
    expect(o.target).toEqual([0, 0, 0]);
  });
});

describe('the sun track', () => {
  it('splits a timelapse into day, dusk and night', () => {
    const b = timelapseBands({ date: '2026-06-21', from: '16:30', to: '20:00', lightsAtDusk: true }, { latitude: 33.749, longitude: -84.388 });
    expect(b.day + b.dusk + b.night).toBeCloseTo(1, 9);
    // Sunset 6:51 pm by the site's clock: about two thirds of the way through.
    expect(b.day).toBeGreaterThan(0.6);
    expect(b.day).toBeLessThan(0.72);
    expect(b.dusk).toBeGreaterThan(0.05);
    expect(b.night).toBeGreaterThan(0.05);
  });

  it('says a view’s time as the board does', () => {
    expect(atWords('2026-06-21T15:00')).toBe('Jun 21 · 3:00 pm');
    expect(atWords('2026-12-01T09:05-05:00')).toBe('Dec 1 · 9:05 am');
  });
});
