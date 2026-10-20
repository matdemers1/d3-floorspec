import { afterEach, describe, expect, it, vi } from 'vitest';
import { seasonOf, SunStore, weatherUnder } from '../src/editor/three/sun/study';
import { skySummary } from '../src/editor/three/sun/SunPanel';
import { lookRequest } from '../src/exports/api';

/**
 * FLR-T-15.4: the season and the weather in the editor — view state kept per project in this
 * browser, never the document's: the weather tiles and the sky preset kept in step (a saved view's
 * `sky` still sets the view exactly as it records it), the studio as the Camera panel's backdrop,
 * "Follow the date", and what a render is asked for.
 */

afterEach(() => { vi.unstubAllGlobals(); });

function stubStorage(): Map<string, string> {
  const kept = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => { kept.set(k, v); } });
  return kept;
}

describe('the weather tiles and the sky', () => {
  it('start as a clear summer day', () => {
    stubStorage();
    expect(new SunStore('p1').get()).toMatchObject({ sky: 'clear', weather: 'clear', season: 'summer', followDate: false });
  });

  it('keep the sky in step: overcast, rain and snow are the overcast sky; clear keeps dusk and night', () => {
    stubStorage();
    const s = new SunStore('p1');
    s.setWeather('rain');
    expect(s.get()).toMatchObject({ sky: 'overcast', weather: 'rain', on: true });
    s.setWeather('snow');
    expect(s.get()).toMatchObject({ sky: 'overcast', weather: 'snow' });
    s.setWeather('clear');
    expect(s.get()).toMatchObject({ sky: 'clear', weather: 'clear' });
    // A saved view's dusk is a time: the clear tile keeps it.
    s.setSky('dusk');
    expect(s.get()).toMatchObject({ sky: 'dusk', weather: 'clear' });
    s.setWeather('clear');
    expect(s.get().sky).toBe('dusk');
    s.setWeather('overcast');
    expect(s.get()).toMatchObject({ sky: 'overcast', weather: 'overcast' });
  });

  it('let a saved view set exactly the sky it records, whatever the weather was', () => {
    stubStorage();
    const s = new SunStore('p1');
    s.setWeather('snow');
    s.setSky('clear');
    expect(s.get()).toMatchObject({ sky: 'clear', weather: 'clear' });
    s.setWeather('rain');
    s.setSky('overcast');
    expect(s.get()).toMatchObject({ sky: 'overcast', weather: 'overcast' });
  });

  it('move the studio to the backdrop, which keeps the weather for the site and brings it back', () => {
    stubStorage();
    const s = new SunStore('p1');
    s.setWeather('rain');
    s.setBackdrop('studio');
    expect(s.get()).toMatchObject({ sky: 'studio', weather: 'rain', on: false });
    // In the studio no weather is drawn: it is for reading the model.
    expect(weatherUnder('studio', 'rain')).toBe('clear');
    s.setBackdrop('site');
    expect(s.get()).toMatchObject({ sky: 'overcast', weather: 'rain', on: true });
    // A weather tile picked in the studio goes back out to the site.
    s.setBackdrop('studio');
    s.setWeather('clear');
    expect(s.get()).toMatchObject({ sky: 'clear', weather: 'clear', on: true });
  });

  it('are kept for the project in this browser, and a kept weather that disagrees with the kept sky is not believed', () => {
    const kept = stubStorage();
    const a = new SunStore('p1');
    a.setWeather('snow');
    a.setSeason('winter');
    const again = new SunStore('p1').get();
    expect(again).toMatchObject({ sky: 'overcast', weather: 'snow', season: 'winter' });
    expect(new SunStore('p2').get()).toMatchObject({ weather: 'clear', season: 'summer' });
    kept.set('floorspec.sky3d.p3', 'clear');
    kept.set('floorspec.look3d.p3', JSON.stringify({ weather: 'snow', season: 'spring' }));
    expect(new SunStore('p3').get()).toMatchObject({ sky: 'clear', weather: 'clear', season: 'spring' });
    kept.set('floorspec.look3d.p4', '{not json');
    expect(new SunStore('p4').get()).toMatchObject({ weather: 'clear', season: 'summer' });
  });
});

describe('the season', () => {
  it('is the one picked, or follows the clock’s date at the site', () => {
    stubStorage();
    const s = new SunStore('p1');
    s.setSeason('autumn');
    expect(seasonOf(s.get(), 40)).toBe('autumn');
    s.setClock({ date: '2026-01-15' });
    s.setFollowDate(true);
    expect(seasonOf(s.get(), 40)).toBe('winter');
    expect(seasonOf(s.get(), -33.9)).toBe('summer');
    // Picking a season stops following the date.
    s.setSeason('spring');
    expect(s.get().followDate).toBe(false);
    expect(seasonOf(s.get(), 40)).toBe('spring');
  });
});

describe('what is said and asked for', () => {
  it('says the weather and the season in the chip when they are not a summer’s day', () => {
    const clock = { date: '2026-10-20', minutes: 15 * 60 + 30, offset: 'auto' as const };
    expect(skySummary('clear', clock)).toBe('Clear day · Oct 20 · 3:30 pm');
    expect(skySummary('clear', clock, { season: 'summer', weather: 'clear' })).toBe('Clear day · Oct 20 · 3:30 pm');
    expect(skySummary('overcast', clock, { season: 'autumn', weather: 'overcast' })).toBe('Overcast · Autumn · Oct 20 · 3:30 pm');
    expect(skySummary('overcast', clock, { season: 'winter', weather: 'snow' })).toBe('Light snow · Winter · Oct 20 · 3:30 pm');
    expect(skySummary('dusk', clock, { season: 'autumn', weather: 'clear' })).toBe('Dusk · Autumn · Oct 20');
    expect(skySummary('studio', clock, { season: 'winter', weather: 'clear' })).toBe('Studio');
  });

  it('asks a render for a season other than summer, and for rain or snow — the sky says clear and overcast', () => {
    expect(lookRequest({ season: 'summer', weather: 'clear' })).toEqual({});
    expect(lookRequest({ season: 'summer', weather: 'overcast' })).toEqual({});
    expect(lookRequest({ season: 'autumn', weather: 'overcast' })).toEqual({ season: 'autumn' });
    expect(lookRequest({ season: 'winter', weather: 'snow' })).toEqual({ season: 'winter', weather: 'snow' });
    expect(lookRequest({ season: 'summer', weather: 'rain' })).toEqual({ weather: 'rain' });
  });
});
