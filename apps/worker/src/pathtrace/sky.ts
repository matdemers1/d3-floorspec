/**
 * The sky a render is seen under, on the worker (FLR-T-13.4, FLR-T-13.9): @floorspec/mesh's sky —
 * the presets, the NOAA sun, the HDRI maps — for a document's site and a request's `sky` and `at`.
 * The maps are read once from the package's files and kept in shared memory, so a still's threads
 * read the same texels rather than a copy each.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  DEFAULT_SITE,
  DEFAULT_SKY,
  isSkyPreset,
  mapsFor,
  SKY_MAP_FILES,
  skyField,
  skyLight,
  skyMapOf,
  sunDay,
  sunPlaceAt,
  sunsetPlace,
  type SkyField,
  type SkyLight,
  type SkyMap,
  type SkyMapId,
  type SkyMaps,
  type SkyPlace,
  type SkyPreset,
  plainLook,
  resolveLook,
  type Look,
  type LookSeason,
  type Weather,
} from '@floorspec/mesh/sky';
import { parseAt, type At, type TimeOfDay } from './presets.js';

const require = createRequire(import.meta.url);
const loaded = new Map<SkyMapId, SkyMap>();

/** A map, read and decoded once, its texels in shared memory. */
export function loadSkyMap(id: SkyMapId): SkyMap {
  const hit = loaded.get(id);
  if (hit !== undefined) return hit;
  const bytes = new Uint8Array(readFileSync(require.resolve(`@floorspec/mesh/sky/${SKY_MAP_FILES[id]}`)));
  const map = skyMapOf(id, bytes);
  const data = new Float32Array(new SharedArrayBuffer(map.data.byteLength));
  data.set(map.data);
  const shared = { ...map, data };
  loaded.set(id, shared);
  return shared;
}

/** The site as the document records it (Core 1.8), degrees; a location the document lacks is DEFAULT_SITE's, and says so. */
export interface Site {
  readonly latitude: number;
  readonly longitude: number;
  readonly trueNorth: number;
  readonly assumed: boolean;
}

export function siteOf(document: object): Site {
  const site = (document as { site?: { trueNorth?: unknown; location?: { latitude?: unknown; longitude?: unknown } } }).site;
  const trueNorth = typeof site?.trueNorth === 'number' ? site.trueNorth / 1e6 : 0;
  const lat = site?.location?.latitude;
  const lon = site?.location?.longitude;
  if (typeof lat === 'number' && typeof lon === 'number') return { latitude: lat / 1e6, longitude: lon / 1e6, trueNorth, assumed: false };
  return { ...DEFAULT_SITE, trueNorth, assumed: true };
}

export interface SkyRequest {
  readonly sky?: SkyPreset;
  /** A date and time at the site (presets.ts `AT_PATTERN`). */
  readonly at?: string;
  /** The sun placed by hand (a still's `sun`), when no `at` places it. */
  readonly sun?: SkyPlace;
  /** The old way of asking (FLR-T-12.22): day, dusk or night, when no `sky` is given. */
  readonly time?: TimeOfDay;
  /**
   * FLR-T-15.4: the season and the weather it is seen in. A weather sets the sky it is seen under
   * (overcast, rain and snow an overcast one; clear a clear one, keeping dusk and night), over `sky`.
   */
  readonly season?: LookSeason | undefined;
  readonly weather?: Weather | undefined;
}

export interface ResolvedSky {
  readonly light: SkyLight;
  readonly field: SkyField;
  readonly site: Site;
  readonly at: At | null;
  /** Where the sun was, and why: an instant at the site, a place asked for, or the preset's default. */
  readonly sun: (SkyPlace & { readonly source: 'at' | 'yours' | 'default' }) | null;
}

const FROM_TIME: Readonly<Record<TimeOfDay, SkyPreset>> = { day: 'clear', dusk: 'dusk', night: 'night' };

/** The sky for a document and a request: its preset, its sun, and its maps loaded. Throws a RangeError for a bad request. */
export function resolveSky(document: object, request: SkyRequest): ResolvedSky {
  if (request.sky !== undefined && !isSkyPreset(request.sky)) throw new RangeError('sky is one of clear, overcast, dusk, night, studio');
  const asked: SkyPreset = request.sky ?? (request.time === undefined ? DEFAULT_SKY : FROM_TIME[request.time]);
  const { sky: preset, look } = resolveLook(asked, { season: request.season, weather: request.weather });
  const site = siteOf(document);
  let at: At | null = null;
  let sun: ResolvedSky['sun'] = null;
  if (request.at !== undefined) {
    at = parseAt(request.at, site.longitude);
    if (at === null) throw new RangeError('at is a date and time at the site, such as 2026-06-21T19:30 (or with an offset, 2026-06-21T19:30-04:00)');
    const place = preset === 'dusk' ? sunsetPlace(sunDay(at.midnight, site.latitude, site.longitude), site.latitude, site.longitude) : null;
    sun = { ...(place ?? sunPlaceAt(at.ms, site.latitude, site.longitude)), source: 'at' };
  } else if (request.sun !== undefined) sun = { ...request.sun, source: 'yours' };
  const light = skyLight(preset, sun, site.trueNorth, look);
  const maps: SkyMaps = {};
  for (const id of mapsFor(light)) maps[id] = loadSkyMap(id);
  return { light, field: skyField(light, maps), site, at, sun: sun ?? (light.sun === null ? null : { ...light.sun, source: 'default' }) };
}

export interface SkySummary {
  readonly preset: SkyPreset;
  /** FLR-T-15.4: the season and the weather, when either is not what the sky was before seasons (summer, dry). */
  readonly look?: Look;
  readonly sun: { readonly azimuth: number; readonly altitude: number; readonly source: 'at' | 'yours' | 'default' } | null;
  readonly at: string | null;
  readonly site: { readonly latitude: number; readonly longitude: number; readonly assumed: boolean };
  readonly exposure?: number;
}

/** What a render says about its sky. */
export function skySummary(sky: ResolvedSky, exposure?: number): SkySummary {
  const r = (v: number) => Math.round(v * 10) / 10;
  const at = sky.at === null ? null : new Date(sky.at.ms + sky.at.offset * 60_000).toISOString().slice(0, 16) + offsetText(sky.at.offset);
  return {
    preset: sky.light.preset,
    ...(plainLook(sky.light.look) ? {} : { look: sky.light.look }),
    sun: sky.sun === null ? null : { azimuth: r(sky.sun.azimuth), altitude: r(sky.sun.altitude), source: sky.sun.source },
    at,
    site: { latitude: sky.site.latitude, longitude: sky.site.longitude, assumed: sky.site.assumed },
    ...(exposure === undefined ? {} : { exposure }),
  };
}

function offsetText(minutes: number): string {
  const a = Math.abs(minutes);
  return `${minutes < 0 ? '-' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

/** Whether a sky's lawn is tinted for its look (FLR-T-15.4): any season but summer, or rain. */
export const lawnTinted = (light: SkyLight): boolean => light.ground.grass && light.ground.tint.some((k) => k !== 1);

/** A tracer's ground under a sky: a plain floor — the studio's, or light snow — or the lawn, tinted for its look. */
export function groundOf(light: SkyLight): { floor?: [number, number, number]; tint?: [number, number, number] } {
  if (!light.ground.grass) return { floor: light.ground.albedo };
  return lawnTinted(light) ? { tint: light.ground.tint } : {};
}
