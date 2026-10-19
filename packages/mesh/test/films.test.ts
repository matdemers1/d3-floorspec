/**
 * FLR-T-14.1: films — keyframes read from the document's extras, easing, the camera path through
 * the keys (centripetal Catmull–Rom, holds and cuts), and the day-to-night timelapse's schedule.
 */
import { describe, expect, it } from 'vitest';
import { catmullRom, ease, filmCameraAt, filmDuration, filmFrameCount, filmNamed, filmProblem, filmRecord, filmShots, filmsOf, filmViewOf, nextFilmId, readFilm, savedViewsOf, UNITS_PER_METRE, viewCamera, type FilmShot } from '../src/index.js';
import { clockWords, sunPlaceAt, timelapseAround, timelapseProblem, timelapseSchedule } from '../src/sky/index.js';

const M = UNITS_PER_METRE;

const views = {
  SV1: { name: 'Hero exterior', eye: [0, -20 * M, 1.6 * M], target: [0, 0, 3 * M], focalLength: 24, twoPoint: true },
  SV2: { name: 'Foyer', eye: [2 * M, -2 * M, 1.6 * M], target: [2 * M, 4 * M, 1.4 * M], focalLength: 20, level: 'L1' },
};

function docWith(films: Record<string, unknown>): object {
  return { floorspec: '0.4', project: { name: 'T' }, extensionsUsed: { FS_views: '0.1.0' }, extensions: { FS_views: { views } }, extras: { d3floorspec: { units: 'metric', films } } };
}

const shot = (at: number, x: number, extra: Partial<FilmShot> = {}): FilmShot => ({ at, ease: 'linear', hold: 0, eye: [x, 0, 0], target: [x, 10, 0], focalLength: 35, exposure: 0, twoPoint: false, levels: 'cutaway', label: `K${String(x)}`, ...extra });

describe('films in the document', () => {
  it('reads films from the extras, in ID order, their keys in time order with defaults', () => {
    const doc = docWith({
      F2: { name: 'Second', keys: [{ at: 0, view: 'SV1' }, { at: 4000, view: 'SV2' }] },
      F1: { name: 'Courtyard walk-in', keys: [{ at: 7000, view: 'SV2', ease: 'linear', hold: 2000 }, { at: 0, view: 'SV1' }, { at: 12000, eye: [1, 2, 3], target: [4, 5, 6] }, { at: -1, view: 'SV1' }, { view: 'SV1' }] },
    });
    const films = filmsOf(doc);
    expect(films.map((f) => f.id)).toEqual(['F1', 'F2']);
    expect(films[0]!.keys).toEqual([
      { at: 0, ease: 'ease', hold: 0, view: 'SV1' },
      { at: 7000, ease: 'linear', hold: 2000, view: 'SV2' },
      { at: 12000, ease: 'ease', hold: 0, eye: [1, 2, 3], target: [4, 5, 6], focalLength: 24 },
    ]);
    expect(filmDuration(films[0]!)).toBe(12000);
    expect(filmsOf({ floorspec: '0.4' })).toEqual([]);
    expect(readFilm('F9', { keys: [] })).toBeUndefined();
  });

  it('finds a film by ID or name, and names the next one', () => {
    const doc = docWith({ F1: { name: 'Courtyard walk-in', keys: [] } });
    expect(filmNamed(doc, 'F1')?.name).toBe('Courtyard walk-in');
    expect(filmNamed(doc, ' courtyard WALK-IN ')?.id).toBe('F1');
    expect(filmNamed(doc, 'Garden')).toBeUndefined();
    expect(nextFilmId((id) => id === 'F1')).toBe('F2');
  });

  it('writes only what differs from the defaults, lengths and times whole', () => {
    expect(filmRecord({ name: 'A', keys: [{ at: 0, ease: 'ease', hold: 0, view: 'SV1' }, { at: 1500.4, ease: 'hold', hold: 999.6, eye: [1.4, 2, 3], target: [4, 5, 6.6], focalLength: 24, name: 'Walk 2' }] })).toEqual({
      name: 'A',
      keys: [{ at: 0, view: 'SV1' }, { at: 1500, ease: 'hold', hold: 1000, eye: [1, 2, 3], target: [4, 5, 7], name: 'Walk 2' }],
    });
    // Round-trips.
    const back = readFilm('F1', filmRecord({ name: 'A', keys: [{ at: 0, ease: 'linear', hold: 500, view: 'SV1' }, { at: 3000, ease: 'ease', hold: 0, view: 'SV2' }] }));
    expect(back?.keys.map((k) => [k.at, k.ease, k.hold, k.view])).toEqual([[0, 'linear', 500, 'SV1'], [3000, 'ease', 0, 'SV2']]);
  });

  it('says what is wrong with a film’s timing', () => {
    expect(filmProblem({ keys: [{ at: 0, ease: 'ease', hold: 0, view: 'SV1' }] })).toBe('a film needs at least two keyframes');
    expect(filmProblem({ keys: [{ at: 0, ease: 'ease', hold: 0, view: 'SV1' }, { at: 500, ease: 'ease', hold: 0, view: 'SV2' }] })).toBe('a film runs at least one second');
    expect(filmProblem({ keys: [{ at: 0, ease: 'ease', hold: 3000, view: 'SV1' }, { at: 2000, ease: 'ease', hold: 0, view: 'SV2' }] })).toMatch(/before keyframe 1 has finished holding/);
    expect(filmProblem({ keys: [{ at: 0, ease: 'ease', hold: 0, view: 'SV1' }, { at: 30_000, ease: 'ease', hold: 0, view: 'SV2' }] })).toBeNull();
    expect(filmFrameCount(30_000, 30)).toBe(900);
    expect(filmFrameCount(30_000, 24)).toBe(720);
  });

  it('makes each key a camera — its saved view’s, or its own — and names the views it lacks', () => {
    const doc = docWith({});
    const { shots, missing } = filmShots({ keys: [{ at: 0, ease: 'ease', hold: 0, view: 'SV1' }, { at: 4000, ease: 'ease', hold: 0, view: 'SV9' }, { at: 8000, ease: 'ease', hold: 0, view: 'SV2' }, { at: 9000, ease: 'linear', hold: 0, eye: [1, 1, 1], target: [2, 2, 2] }] }, savedViewsOf(doc));
    expect(missing).toEqual(['SV9']);
    expect(shots.map((s) => [s.label, s.focalLength, s.level ?? null])).toEqual([['Hero exterior', 24, null], ['Foyer', 20, 'L1'], ['Walk 4', 24, null]]);
  });
});

describe('easing', () => {
  it('runs linear, eased in and out, and held', () => {
    expect([0, 0.25, 0.5, 1].map((u) => ease('linear', u))).toEqual([0, 0.25, 0.5, 1]);
    expect(ease('ease', 0)).toBe(0);
    expect(ease('ease', 0.5)).toBe(0.5);
    expect(ease('ease', 1)).toBe(1);
    // Slow at both ends, fast in the middle.
    expect(ease('ease', 0.1)).toBeLessThan(0.1);
    expect(ease('ease', 0.9)).toBeGreaterThan(0.9);
    expect(ease('ease', 0.6) - ease('ease', 0.4)).toBeGreaterThan(0.2);
    expect([0, 0.5, 0.999, 1].map((u) => ease('hold', u))).toEqual([0, 0, 0, 1]);
    // Clamped.
    expect(ease('ease', -1)).toBe(0);
    expect(ease('linear', 2)).toBe(1);
  });
});

describe('the camera path', () => {
  it('passes through every keyframe at its time, and holds there', () => {
    const shots = [shot(0, 0), shot(1000, 10, { hold: 500 }), shot(3000, 20), shot(4000, 40)];
    expect(filmCameraAt(shots, 0).eye).toEqual([0, 0, 0]);
    expect(filmCameraAt(shots, 1000).eye).toEqual([10, 0, 0]);
    expect(filmCameraAt(shots, 1250)).toMatchObject({ eye: [10, 0, 0], key: 1, towards: 0 });
    expect(filmCameraAt(shots, 1500).eye).toEqual([10, 0, 0]);
    expect(filmCameraAt(shots, 3000).eye).toEqual([20, 0, 0]);
    expect(filmCameraAt(shots, 4000).eye).toEqual([40, 0, 0]);
    // Before the start and after the end: the first and the last.
    expect(filmCameraAt(shots, -50).eye).toEqual([0, 0, 0]);
    expect(filmCameraAt(shots, 9000).eye).toEqual([40, 0, 0]);
    // Leaving after the hold: on its way to the next key.
    const leaving = filmCameraAt(shots, 2250);
    expect(leaving.key).toBe(1);
    expect(leaving.towards).toBeCloseTo(0.5, 9);
    expect(leaving.eye[0]).toBeGreaterThan(10);
    expect(leaving.eye[0]).toBeLessThan(20);
    expect(leaving.label).toBe('K10 → K20');
  });

  it('moves monotonically between keys spaced unevenly — the centripetal spline never overshoots', () => {
    const shots = [shot(0, 0), shot(1000, 1), shot(2000, 100), shot(3000, 101)];
    let last = -Infinity;
    for (let t = 0; t <= 3000; t += 25) {
      const x = filmCameraAt(shots, t).eye[0];
      expect(x).toBeGreaterThanOrEqual(last - 1e-9);
      expect(x).toBeLessThanOrEqual(101 + 1e-9);
      last = x;
    }
  });

  it('bends smoothly through a key: the path curves round a corner rather than turning sharply', () => {
    const corner: FilmShot[] = [{ ...shot(0, 0) }, { ...shot(1000, 10) }, { ...shot(2000, 10), eye: [10, 10, 0] }];
    const p = filmCameraAt(corner, 1500).eye;
    // Off the straight line from (10,0) to (10,10): it swings outwards past x = 10 on the way.
    expect(p[0]).toBeGreaterThan(10);
    // And a spline segment is the straight line when every key is on one.
    const line = [shot(0, 0), shot(1000, 10), shot(2000, 20)];
    expect(filmCameraAt(line, 500).eye[1]).toBeCloseTo(0, 9);
    expect(filmCameraAt(line, 500).eye[0]).toBeCloseTo(5, 6);
  });

  it('eases time along a segment as the arriving key says', () => {
    const linear = [shot(0, 0), shot(1000, 10), shot(2000, 20)];
    const eased = [shot(0, 0), shot(1000, 10, { ease: 'ease' }), shot(2000, 20, { ease: 'ease' })];
    expect(filmCameraAt(linear, 250).towards).toBeCloseTo(0.25, 9);
    expect(filmCameraAt(eased, 250).towards).toBeCloseTo(ease('ease', 0.25), 9);
    expect(filmCameraAt(eased, 250).eye[0]).toBeLessThan(filmCameraAt(linear, 250).eye[0]);
  });

  it('cuts on a held key: the camera waits, then jumps, and the spline does not reach across the cut', () => {
    const shots = [shot(0, 0), shot(1000, 10), shot(2000, 50, { ease: 'hold' }), shot(3000, 60)];
    expect(filmCameraAt(shots, 1999).eye).toEqual([10, 0, 0]);
    expect(filmCameraAt(shots, 2000).eye).toEqual([50, 0, 0]);
    // 0 → 10 is a straight run: the far key (50, after the cut) does not bend it.
    expect(filmCameraAt(shots, 500).eye[0]).toBeCloseTo(5, 6);
  });

  it('interpolates the lens geometrically, the exposure linearly, and keeps two-point only when both ends have it', () => {
    const shots = [shot(0, 0, { focalLength: 16, exposure: -10, twoPoint: true }), shot(1000, 10, { focalLength: 64, exposure: 10, twoPoint: false, level: 'L2' })];
    const mid = filmCameraAt(shots, 500);
    expect(mid.focalLength).toBeCloseTo(32, 9);
    expect(mid.exposure).toBeCloseTo(0, 9);
    expect(mid.twoPoint).toBe(false);
    expect(filmCameraAt(shots, 400).level).toBeUndefined();
    expect(filmCameraAt(shots, 600).level).toBe('L2');
  });

  it('is a 16:9 view the renderers already look through', () => {
    const shots = [shot(0, 0), shot(1000, 10 * M)];
    const v = filmViewOf(filmCameraAt(shots, 500));
    expect(v.aspect).toBe('16:9');
    const cam = viewCamera(v);
    expect(cam.aspect).toBeCloseTo(16 / 9, 9);
    expect(cam.eye[0]).toBeCloseTo(5, 6);
  });

  it('agrees with the spline it is made from', () => {
    const p = catmullRom([0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0], 0.5);
    expect(p[0]).toBeCloseTo(1.5, 9);
    expect(catmullRom([0, 0, 0], [1, 1, 1], [1, 1, 1], [2, 2, 2], 0.3)).toEqual([1, 1, 1]);
  });
});

describe('day to night', () => {
  // The Courtyard House's site: Atlanta, 33.749° N, 84.388° W — read in UTC−6 by its longitude.
  const site = { latitude: 33.749, longitude: -84.388 };
  const plan = { date: '2026-06-21', from: '16:30', to: '21:30', lightsAtDusk: true };

  it('runs the clock at the site from the start to the end', () => {
    const s = timelapseSchedule(plan, site);
    expect(s.offset).toBe(-360);
    expect(s.end - s.start).toBe(5 * 3600_000);
    expect(s.at(0)).toMatchObject({ at: '2026-06-21T16:30:00', clock: '4:30 pm' });
    expect(s.at(0.5)).toMatchObject({ at: '2026-06-21T19:00:00', clock: '7:00 pm' });
    expect(s.at(1)).toMatchObject({ at: '2026-06-21T21:30:00', clock: '9:30 pm' });
    // The sun is NOAA's at each instant, and sets on the way.
    expect(s.at(0).sun).toEqual(sunPlaceAt(s.start, site.latitude, site.longitude));
    expect(s.at(0).sun.altitude).toBeGreaterThan(20);
    expect(s.at(1).sun.altitude).toBeLessThan(-6);
  });

  it('brings the lights up over ten minutes after sunset, and leaves them off when asked', () => {
    const s = timelapseSchedule(plan, site);
    expect(s.sunset).not.toBeNull();
    const sunset = s.sunset!;
    const u = (ms: number) => (ms - s.start) / (s.end - s.start);
    expect(s.at(u(sunset - 60_000)).lamps).toBe(0);
    expect(s.at(u(sunset + 5 * 60_000)).lamps).toBeCloseTo(0.5, 1);
    expect(s.at(u(sunset + 11 * 60_000)).lamps).toBe(1);
    expect(s.at(1).lamps).toBe(1);
    expect(timelapseSchedule({ ...plan, lightsAtDusk: false }, site).at(1).lamps).toBe(0);
    // Sunset on the solstice at the Courtyard House: 8:51 pm EDT, 6:51 pm by the site's own clock (UTC−6, no daylight saving).
    expect(s.clockOf(sunset)).toMatch(/^6:5\d pm$/);
  });

  it('runs past midnight when the end is before the start, and refuses what is not a day and two times', () => {
    const s = timelapseSchedule({ ...plan, from: '22:00', to: '02:00' }, site);
    expect(s.end - s.start).toBe(4 * 3600_000);
    expect(s.at(1).at).toBe('2026-06-22T02:00:00');
    expect(timelapseProblem({ ...plan, date: '2026-02-30' })).toMatch(/not a day/);
    expect(timelapseProblem({ ...plan, from: '25:00' })).toMatch(/HH:MM/);
    expect(timelapseProblem({ ...plan, to: '16:30' })).toMatch(/different times/);
    expect(() => timelapseSchedule({ ...plan, date: 'June' }, site)).toThrow(RangeError);
  });

  it('sets the preset round the site’s sunset: two hours before it to an hour after, on the half hour', () => {
    expect(timelapseAround('2026-06-21', site)).toEqual({ date: '2026-06-21', from: '16:30', to: '20:00', lightsAtDusk: true });
    // Where the sun does not set: the board's own times.
    expect(timelapseAround('2026-06-21', { latitude: 78, longitude: 15 })).toMatchObject({ from: '16:30', to: '21:30' });
  });

  it('says a clock as the board does', () => {
    expect([0, 12 * 60, 16 * 60 + 30, 20 * 60 + 31, 23 * 60 + 59].map(clockWords)).toEqual(['12:00 am', '12:00 pm', '4:30 pm', '8:31 pm', '11:59 pm']);
  });
});
