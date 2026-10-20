import { useMemo, useSyncExternalStore } from 'react';
import type { EditorStore } from '../../store';
import type { EditorModel } from '../../model';
import { DEFAULT_SEASON, DEFAULT_SITE, DEFAULT_SKY, isLookSeason, isSkyPreset, isWeather, seasonOfMonth, weatherOfSky, type Look, type LookSeason, type SkyPreset, type Weather } from '@floorspec/mesh/sky';
import { instantOfClock, midnightOf, nowIn, offsetOf, type Clock } from './clock';
import { sunAt, sunDay, sunVector, type SunDay, type SunPosition } from './solar';

/**
 * The sun and shadow study's state (FLR-T-8.6, FLR-REQ-123), beside the 3D view's own (mode.ts) and
 * like it one per editor: whether the sun is on, whether its panel is open, and the clock. The site
 * — latitude, longitude, true north — is the document's (Core 1.8) and changes only by Ops; the
 * clock is the person's and is never written to the document.
 */

export const MICRO = 1_000_000;

export interface SunState {
  /**
   * The sky the 3D view is seen under (FLR-T-13.4): a clear day by default, kept per project in this
   * browser. Every preset but `studio` lights the view by its sky and sun and stands the house on
   * the lawn; `studio` is the even light the view has always had.
   */
  sky: SkyPreset;
  /** The sun lights the 3D view and casts shadows: any sky but the studio. */
  on: boolean;
  /** The Sky and sun panel is showing over the 3D view. */
  open: boolean;
  clock: Clock;
  /** The time slider advancing by itself; only ever started by a person. */
  playing: boolean;
  /** Playing as a timelapse (FLR-T-13.9): from sunrise to sunset on the date, then stopping at sunset. */
  lapse: boolean;
  /**
   * FLR-T-15.4: the weather — clear, overcast, rain-wet or light snow — kept per project in this
   * browser. It and `sky` agree: an overcast, rainy or snowy weather is the overcast sky; a clear one
   * a clear, dusk or night sky (or the studio backdrop, which keeps the weather for the site).
   */
  weather: Weather;
  /** FLR-T-15.4: the season picked, summer by default; `followDate` takes the clock's instead. */
  season: LookSeason;
  /** The season follows the clock's date at the site (meteorological, south of the equator turned). Off by default. */
  followDate: boolean;
}

const skyKey = (projectId: string): string => `floorspec.sky3d.${projectId}`;
const lookKey = (projectId: string): string => `floorspec.look3d.${projectId}`;

function readSky(projectId: string | null): SkyPreset {
  if (projectId === null) return DEFAULT_SKY;
  try {
    const v = localStorage.getItem(skyKey(projectId));
    return isSkyPreset(v) ? v : DEFAULT_SKY;
  } catch {
    return DEFAULT_SKY;
  }
}

/** The season, the weather and "Follow the date" kept for a project (FLR-T-15.4); what is not kept is the default. */
function readLook(projectId: string | null, sky: SkyPreset): { weather: Weather; season: LookSeason; followDate: boolean } {
  const fallback = { weather: weatherOfSky(sky), season: DEFAULT_SEASON, followDate: false };
  if (projectId === null) return fallback;
  try {
    const v = JSON.parse(localStorage.getItem(lookKey(projectId)) ?? 'null') as { weather?: unknown; season?: unknown; followDate?: unknown } | null;
    if (v === null || typeof v !== 'object') return fallback;
    // The weather kept must agree with the sky kept: rain and snow only over the overcast sky.
    const weather = isWeather(v.weather) && (v.weather === 'rain' || v.weather === 'snow' ? sky === 'overcast' : weatherOfSky(sky) === v.weather || sky === 'studio') ? v.weather : fallback.weather;
    return { weather, season: isLookSeason(v.season) ? v.season : DEFAULT_SEASON, followDate: v.followDate === true };
  } catch {
    return fallback;
  }
}

/**
 * The weather a sky preset is seen in, given the weather picked (FLR-T-15.4): rain and snow over the
 * overcast sky they are; any other sky its own weather — the studio backdrop none (it is for reading
 * the model, not the light; the weather picked comes back with the site).
 */
export function weatherUnder(sky: SkyPreset, picked: Weather): Weather {
  if (sky === 'overcast' && (picked === 'rain' || picked === 'snow')) return picked;
  return weatherOfSky(sky);
}

/** The season the view is seen in: the one picked, or — following the date — the clock's at the site. */
export function seasonOf(state: Pick<SunState, 'season' | 'followDate' | 'clock'>, latitude: number): LookSeason {
  if (!state.followDate) return state.season;
  const month = Number(state.clock.date.slice(5, 7));
  return Number.isInteger(month) && month >= 1 && month <= 12 ? seasonOfMonth(month, latitude) : state.season;
}

export class SunStore {
  private state: SunState;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly projectId: string | null = null) {
    const today = nowIn('auto');
    const sky = readSky(projectId);
    // The board's "Sun · Oct 4 · 3 pm": today, mid-afternoon, when shadows read well.
    this.state = { sky, on: sky !== 'studio', open: false, clock: { date: today.date, minutes: 15 * 60, offset: 'auto' }, playing: false, lapse: false, ...readLook(projectId, sky) };
  }

  get = (): SunState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(patch: Partial<SunState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  setClock(patch: Partial<Clock>): void {
    this.set({ clock: { ...this.state.clock, ...patch } });
  }

  /** The toolbar's Sun button: the Sky and sun panel open, or closed. */
  toggle(): void {
    this.set(this.state.open ? { open: false, playing: false, lapse: false } : { open: true });
  }

  /**
   * Set the sky preset (FLR-T-13.4): a saved view's, or the Camera panel's backdrop. Remembered for
   * this project in this browser. Its weather follows it (a saved view records a sky, not a weather:
   * going to one shows exactly what it records); the studio backdrop keeps the weather for the site.
   */
  setSky(sky: SkyPreset): void {
    const weather = sky === 'studio' ? this.state.weather : weatherOfSky(sky);
    if (sky !== this.state.sky || weather !== this.state.weather) this.set({ sky, weather, on: sky !== 'studio', ...(sky === 'dusk' || sky === 'night' || sky === 'studio' ? { playing: false, lapse: false } : {}) });
    this.keep();
  }

  /**
   * Pick a weather (FLR-T-15.4), the Sky and sun panel's tiles: clear keeps a clear, dusk or night
   * sky (and leaves an overcast one for a clear day); overcast, rain-wet and light snow are the
   * overcast sky. From the studio backdrop it goes back out to the site.
   */
  setWeather(weather: Weather): void {
    const now = this.state.sky;
    const sky: SkyPreset = weather === 'clear' ? (now === 'overcast' || now === 'studio' ? 'clear' : now) : 'overcast';
    if (sky !== now || weather !== this.state.weather) this.set({ sky, weather, on: true });
    this.keep();
  }

  /** The Camera panel's backdrop (FLR-T-15.4): the studio, or back out to the site under the weather picked. */
  setBackdrop(backdrop: 'site' | 'studio'): void {
    if (backdrop === 'studio') this.setSky('studio');
    else if (this.state.sky === 'studio') this.setWeather(this.state.weather);
  }

  /** Pick a season (FLR-T-15.4); picking one stops following the date. */
  setSeason(season: LookSeason): void {
    this.set({ season, followDate: false });
    this.keep();
  }

  /** Follow the clock's date for the season, or stop (keeping the season it was showing, `season`). */
  setFollowDate(followDate: boolean, showing?: LookSeason): void {
    this.set({ followDate, ...(showing === undefined ? {} : { season: showing }) });
    this.keep();
  }

  /** The look the view is seen in (FLR-T-15.4) at a site's latitude. */
  look(latitude: number): Look {
    return { season: seasonOf(this.state, latitude), weather: this.state.weather };
  }

  private keep(): void {
    if (this.projectId === null) return;
    try {
      localStorage.setItem(skyKey(this.projectId), this.state.sky);
      localStorage.setItem(lookKey(this.projectId), JSON.stringify({ weather: this.state.weather, season: this.state.season, followDate: this.state.followDate }));
    } catch {
      // Storage refused (a private window): the choice lasts for this session.
    }
  }
}

const stores = new WeakMap<EditorStore, SunStore>();

export function sunOf(store: EditorStore): SunStore {
  let sun = stores.get(store);
  if (sun === undefined) {
    sun = new SunStore(store.projectId);
    stores.set(store, sun);
  }
  return sun;
}

export function useSunState<T>(store: EditorStore, selector: (s: SunState) => T): T {
  const sun = sunOf(store);
  return useSyncExternalStore(sun.subscribe, () => selector(sun.get()));
}

/**
 * The season and the weather the 3D view is seen in (FLR-T-15.4), at the model's site (an assumed
 * one's latitude when it records none): a look, never the model's.
 */
export function useLook(store: EditorStore, model: EditorModel | null): Look {
  const weather = useSunState(store, (s) => s.weather);
  const latitude = placedSite(siteOf(model)).latitude ?? DEFAULT_SITE.latitude;
  const season = useSunState(store, (s) => seasonOf(s, latitude));
  return useMemo(() => ({ season, weather }), [season, weather]);
}

/** The look the 3D view draws its parts in: the season, and the weather the sky shown is seen in (none in the studio). */
export function useViewLook(store: EditorStore, model: EditorModel | null): Look {
  const look = useLook(store, model);
  const sky = useSunState(store, (s) => s.sky);
  const weather = weatherUnder(sky, look.weather);
  return useMemo(() => ({ season: look.season, weather }), [look.season, weather]);
}

// ─── The site, as the document has it ────────────────────────────────────────────────────────

export interface Site {
  /** Degrees; null when the document records no location. */
  latitude: number | null;
  longitude: number | null;
  /** Degrees from project north (+Y) to true north, counter-clockwise positive (Core 1.8). */
  trueNorth: number;
  /** The document has a `site` at all. */
  present: boolean;
}

interface SiteJson {
  trueNorth?: number;
  location?: { latitude: number; longitude: number };
}

/**
 * The site the sky is placed from: the document's, or — when it records no location — DEFAULT_SITE
 * (40° N, 75° W), which the panel says it is assuming.
 */
export function placedSite(site: Site): Site & { assumed: boolean } {
  if (site.latitude !== null && site.longitude !== null) return { ...site, assumed: false };
  return { ...site, latitude: DEFAULT_SITE.latitude, longitude: DEFAULT_SITE.longitude, assumed: true };
}

export function siteOf(model: EditorModel | null): Site {
  const site = (model?.document as { site?: SiteJson } | undefined)?.site;
  const loc = site?.location;
  return {
    latitude: loc === undefined ? null : loc.latitude / MICRO,
    longitude: loc === undefined ? null : loc.longitude / MICRO,
    trueNorth: (site?.trueNorth ?? 0) / MICRO,
    present: site !== undefined,
  };
}

// ─── The study: where the sun is, for a site and a clock ─────────────────────────────────────

export interface Study {
  instant: number;
  offset: number;
  position: SunPosition;
  /** Towards the sun in the project's frame (x east, y north, z up), unit length. */
  vector: [number, number, number];
  /** The sun is below the horizon (apparent altitude under zero). */
  night: boolean;
  /** 0 at night, rising to 1 a few degrees above the horizon: how strongly the sun lights the house. */
  daylight: number;
}

/** The sun for a site and a clock; null when the site has no location to place it from. */
export function studyOf(site: Site, clock: Clock): Study | null {
  if (site.latitude === null || site.longitude === null) return null;
  const instant = instantOfClock(clock);
  const position = sunAt(instant, site.latitude, site.longitude);
  const night = position.altitude < 0;
  const daylight = night ? 0 : Math.min(1, position.altitude / 6) ** 0.5;
  return {
    instant,
    offset: offsetOf(clock),
    position,
    vector: sunVector(position.azimuth, position.altitude, site.trueNorth),
    night,
    daylight,
  };
}

/** The site as a key: a new model with the same site keeps the same study. */
function siteKey(site: Site): string {
  return `${String(site.latitude)},${String(site.longitude)},${String(site.trueNorth)}`;
}

/** The study for the model's site and a clock, recomputed only when either changes; null when the sun is off. */
export function useStudy(model: EditorModel | null, on: boolean, clock: Clock): Study | null {
  const site = siteOf(model);
  const key = siteKey(site);
  return useMemo(() => (on ? studyOf(siteFromKey(key), clock) : null), [on, key, clock]);
}

function siteFromKey(key: string): Site {
  const [lat, lon, north] = key.split(',');
  return { latitude: lat === 'null' ? null : Number(lat), longitude: lon === 'null' ? null : Number(lon), trueNorth: Number(north), present: true };
}

/** Sunrise, solar noon and sunset on the clock's date at the site; null without a location. */
export function dayOf(site: Site, clock: Clock): SunDay | null {
  if (site.latitude === null || site.longitude === null) return null;
  return sunDay(midnightOf(clock), site.latitude, site.longitude);
}

/** Metres per texel the shadow map aims for. */
const TEXEL = 0.02;

/** The shadow map's size for a house of a given radius (metres). */
export function shadowMapSize(radius: number, opts: { compact: boolean; max: number }): number {
  const want = (2 * radius) / TEXEL;
  let size = 1024;
  while (size < want && size < 4096) size *= 2;
  if (opts.compact) size = Math.max(1024, size / 2);
  return Math.min(size, Math.max(1024, opts.max));
}
