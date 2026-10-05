import { useMemo, useSyncExternalStore } from 'react';
import type { EditorStore } from '../../store';
import type { EditorModel } from '../../model';
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
  /** The sun lights the 3D view and casts shadows. */
  on: boolean;
  /** The Sun panel is showing over the 3D view. */
  open: boolean;
  clock: Clock;
  /** The time slider advancing by itself; only ever started by a person. */
  playing: boolean;
}

export class SunStore {
  private state: SunState;
  private readonly listeners = new Set<() => void>();

  constructor() {
    const today = nowIn('auto');
    // The board's "Sun · Oct 4 · 3 pm": today, mid-afternoon, when shadows read well.
    this.state = { on: false, open: false, clock: { date: today.date, minutes: 15 * 60, offset: 'auto' }, playing: false };
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

  /** The toolbar's Sun button: on with its panel open, or off. */
  toggle(): void {
    this.set(this.state.on ? { on: false, open: false, playing: false } : { on: true, open: true });
  }
}

const stores = new WeakMap<EditorStore, SunStore>();

export function sunOf(store: EditorStore): SunStore {
  let sun = stores.get(store);
  if (sun === undefined) {
    sun = new SunStore();
    stores.set(store, sun);
  }
  return sun;
}

export function useSunState<T>(store: EditorStore, selector: (s: SunState) => T): T {
  const sun = sunOf(store);
  return useSyncExternalStore(sun.subscribe, () => selector(sun.get()));
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
