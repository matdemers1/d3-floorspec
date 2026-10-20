import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SEASON,
  groundLook,
  isLookSeason,
  isWeather,
  lawnAlbedo,
  LAWN_TINT,
  LOOK_SEASONS,
  resolveLook,
  seasonOfMonth,
  SEASON_SKY_TINT,
  skyExposure,
  skyForWeather,
  skyLight,
  skyMapOf,
  SKY_PRESETS,
  SNOW_ALBEDO,
  weatherOfSky,
  WEATHERS,
  WEATHER_SKY,
  WET,
  wetten,
  type SkyMap,
} from '../src/sky/index.js';

/**
 * FLR-T-15.4: the weather → sky and material parameters, and the season → sky and ground — each a
 * look over the sky the view already had, and nothing at all when a request names neither.
 */

function evenMap(id: 'clear' | 'overcast' | 'dusk' | 'night', w = 64): SkyMap {
  const h = Math.round((w / 2) * (96 / 180));
  return skyMapOf(id, { width: w, height: h, data: new Float32Array(w * h * 3).fill(1) });
}
const MAPS = { clear: evenMap('clear'), overcast: evenMap('overcast'), dusk: evenMap('dusk'), night: evenMap('night') };
const SUN = { azimuth: 200, altitude: 40 };
const lum = (c: readonly number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;

describe('a look’s defaults', () => {
  it('are summer and the weather the sky already is, which change no sky', () => {
    expect(DEFAULT_SEASON).toBe('summer');
    expect(weatherOfSky('overcast')).toBe('overcast');
    for (const p of ['clear', 'dusk', 'night', 'studio'] as const) expect(weatherOfSky(p)).toBe('clear');
    for (const preset of SKY_PRESETS)
      for (const sun of [SUN, { azimuth: 300, altitude: -4 }, { azimuth: 90, altitude: -20 }, null]) {
        const plain = skyLight(preset, sun, 12);
        expect(plain.look).toEqual({ season: 'summer', weather: weatherOfSky(preset) });
        expect(skyLight(preset, sun, 12, { season: 'summer', weather: weatherOfSky(preset) })).toEqual(plain);
        expect(plain.ground.tint).toEqual([1, 1, 1]);
      }
    // The lawn's albedo is exactly the grass's, as before seasons.
    expect(skyLight('clear', SUN).ground.albedo).toEqual(lawnAlbedo());
  });

  it('reads a season and a weather by name', () => {
    expect(LOOK_SEASONS).toEqual(['spring', 'summer', 'autumn', 'winter']);
    expect(WEATHERS).toEqual(['clear', 'overcast', 'rain', 'snow']);
    expect(isLookSeason('autumn')).toBe(true);
    expect(isLookSeason('fall')).toBe(false);
    expect(isWeather('snow')).toBe(true);
    expect(isWeather('hail')).toBe(false);
  });
});

describe('the weather → sky', () => {
  it('is a clear sky for clear, keeping dusk and night, and an overcast one for overcast, rain and snow; the studio stays', () => {
    expect(skyForWeather('overcast', 'clear')).toBe('clear');
    expect(skyForWeather('dusk', 'clear')).toBe('dusk');
    expect(skyForWeather('night', 'clear')).toBe('night');
    for (const w of ['overcast', 'rain', 'snow'] as const) for (const p of ['clear', 'dusk', 'night', 'overcast'] as const) expect(skyForWeather(p, w)).toBe('overcast');
    for (const w of WEATHERS) expect(skyForWeather('studio', w)).toBe('studio');
    expect(skyForWeather('dusk', undefined)).toBe('dusk');
    expect(resolveLook('clear', { weather: 'rain', season: 'autumn' })).toEqual({ sky: 'overcast', look: { season: 'autumn', weather: 'rain' } });
    expect(resolveLook('night', {})).toEqual({ sky: 'night', look: { season: 'summer', weather: 'clear' } });
  });

  it('darkens the cloud for rain, brightens it for snow, and closes in the haze', () => {
    const e = (weather: 'overcast' | 'rain' | 'snow') => skyLight('overcast', SUN, 0, { weather }).layers[0]!.lux;
    expect(e('rain')).toBeCloseTo(e('overcast') * WEATHER_SKY.rain.lux, 6);
    expect(e('snow')).toBeGreaterThan(e('overcast'));
    const plain = skyLight('overcast', SUN);
    const rain = skyLight('overcast', SUN, 0, { weather: 'rain' });
    expect(rain.haze.far).toBeLessThan(plain.haze.far);
    expect(rain.direct).toBeNull();
    // Rain reads darker than a meter would make it, and snow brighter.
    expect(skyExposure(rain, MAPS)).toBeLessThan(skyExposure(skyLight('overcast', SUN, 0, { weather: 'overcast' }), MAPS) * WEATHER_SKY.rain.lux ** -1);
  });

  it('wets the ground when it rains and lays snow on it when it snows', () => {
    const lawn = lawnAlbedo();
    const rain = groundLook({ season: 'summer', weather: 'rain' }, lawn);
    expect(rain.grass).toBe(true);
    expect(rain.tint).toEqual([WET.darken, WET.darken, WET.darken]);
    const snow = skyLight('overcast', SUN, 0, { weather: 'snow' }).ground;
    expect(snow.grass).toBe(false);
    expect(snow.albedo).toEqual(SNOW_ALBEDO);
    expect(lum(SNOW_ALBEDO)).toBeGreaterThan(0.7);
    // A wet surface is darker and glossier; one already glossier keeps its gloss.
    expect(wetten([0.5, 0.4, 0.3], 0.9)).toEqual({ color: [0.5 * WET.darken, 0.4 * WET.darken, 0.3 * WET.darken], roughness: WET.roughness });
    expect(wetten([0.5, 0.4, 0.3], 0.1).roughness).toBe(0.1);
  });
});

describe('the season → sky and ground', () => {
  it('tints the sky without changing its brightness: warmer in autumn, cooler in winter', () => {
    for (const s of LOOK_SEASONS) expect(lum(SEASON_SKY_TINT[s])).toBeCloseTo(1, 9);
    expect(SEASON_SKY_TINT.summer).toEqual([1, 1, 1]);
    expect(SEASON_SKY_TINT.autumn[0]).toBeGreaterThan(SEASON_SKY_TINT.autumn[2]);
    expect(SEASON_SKY_TINT.winter[2]).toBeGreaterThan(SEASON_SKY_TINT.winter[0]);
    const winter = skyLight('clear', SUN, 0, { season: 'winter' });
    expect(winter.layers[0]!.tint).toEqual(SEASON_SKY_TINT.winter);
  });

  it('greens the lawn in spring, yellows it in autumn and leaves it dormant in winter', () => {
    const lawn = lawnAlbedo();
    const g = (season: (typeof LOOK_SEASONS)[number]) => groundLook({ season, weather: 'clear' }, lawn).albedo;
    expect(g('summer')).toEqual(lawn);
    expect(g('spring')[1]).toBeGreaterThan(lawn[1]);
    expect(g('autumn')[0] / g('autumn')[1]).toBeGreaterThan(lawn[0] / lawn[1]);
    expect(g('winter')[0] / g('winter')[1]).toBeGreaterThan(g('autumn')[0] / g('autumn')[1]);
    expect(LAWN_TINT.summer).toEqual([1, 1, 1]);
  });

  it('follows the date: meteorological seasons, turned half a year south of the equator', () => {
    expect(seasonOfMonth(10, 33.7)).toBe('autumn');
    expect(seasonOfMonth(1, 40)).toBe('winter');
    expect(seasonOfMonth(4, 40)).toBe('spring');
    expect(seasonOfMonth(7, 40)).toBe('summer');
    expect(seasonOfMonth(12, 40)).toBe('winter');
    expect(seasonOfMonth(7, -33.9)).toBe('winter');
    expect(seasonOfMonth(10, -33.9)).toBe('spring');
    expect(seasonOfMonth(1, -33.9)).toBe('summer');
  });
});
