/**
 * Day to night (FLR-T-14.1): a film's timelapse — the clock at the site run from one time to another
 * over the film, the sun placed by NOAA at every moment under the clear sky (whose dome follows it
 * through sunset into dusk and night: sky.ts `skyLight`), and the house's lights coming on at dusk,
 * each fading up over the ten minutes after sunset.
 *
 * Floorspec records no time zone: a clock is read in the site's zone by its longitude, 15° an hour,
 * as a view's `at` is (the worker's presets.ts `parseAt`), so `at` strings written here without an
 * offset mean the same instants there.
 */
import { DEFAULT_SITE, sunPlaceAt, type SkyPlace } from './sky.js';
import { sunDay } from './solar.js';

export interface Timelapse {
  /** The day, `YYYY-MM-DD`. */
  readonly date: string;
  /** The clock at the start and at the end, `HH:MM` at the site; an end before the start is the next day. */
  readonly from: string;
  readonly to: string;
  /** The lights come on at dusk. */
  readonly lightsAtDusk: boolean;
}

/** The board's preset: half past four to half past nine, the lights coming on. */
export const DEFAULT_TIMELAPSE = { from: '16:30', to: '21:30', lightsAtDusk: true } as const;
/** How long a fixture takes to fade up after sunset, ms. */
export const LIGHTS_FADE_MS = 10 * 60_000;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Whether a timelapse's date and clocks are well-formed. */
export function timelapseProblem(plan: Timelapse): string | null {
  const d = DATE.exec(plan.date);
  if (d === null) return 'the date is YYYY-MM-DD';
  const probe = new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3])));
  if (probe.getUTCMonth() !== Number(d[2]) - 1 || probe.getUTCDate() !== Number(d[3])) return 'the date is not a day of the calendar';
  if (!CLOCK.test(plan.from) || !CLOCK.test(plan.to)) return 'the times are HH:MM, 00:00 to 23:59';
  if (plan.from === plan.to) return 'the timelapse starts and ends at different times';
  return null;
}

/** June 21 of a year: the day the board's timelapse is set on. */
export const midsummer = (year: number): string => `${String(year)}-06-21`;

const minutesOf = (clock: string): number => {
  const [h, m] = clock.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

/** What the timelapse is at a moment of the film. */
export interface TimelapseMoment {
  /** The instant, UTC ms. */
  readonly ms: number;
  /** As `at` takes it: the site's own clock, `2026-06-21T19:30:00`. */
  readonly at: string;
  /** "7:12 pm". */
  readonly clock: string;
  readonly sun: SkyPlace;
  /** How far up the house's lights are, 0–1. */
  readonly lamps: number;
}

export interface TimelapseSchedule {
  readonly start: number;
  readonly end: number;
  /** Minutes east of UTC the site's clock is read in. */
  readonly offset: number;
  /** Sunset that day, UTC ms; null when the sun does not set. */
  readonly sunset: number | null;
  /** The moment `u` (0–1) of the way through. */
  at(u: number): TimelapseMoment;
  /** A time of day at the site, as the board writes it: "8:31 pm". */
  clockOf(ms: number): string;
}

/** "7:12 pm", from minutes after midnight. */
export function clockWords(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${String(h12)}:${String(mm).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

/** The schedule of a timelapse at a site (degrees; DEFAULT_SITE when it has no location). */
export function timelapseSchedule(plan: Timelapse, site: { readonly latitude?: number | null; readonly longitude?: number | null } = {}): TimelapseSchedule {
  const problem = timelapseProblem(plan);
  if (problem !== null) throw new RangeError(problem);
  const latitude = site.latitude ?? DEFAULT_SITE.latitude;
  const longitude = site.longitude ?? DEFAULT_SITE.longitude;
  const [y, mo, d] = plan.date.split('-').map(Number) as [number, number, number];
  const offset = Math.round(longitude / 15) * 60;
  const midnight = Date.UTC(y, mo - 1, d) - offset * 60_000;
  const from = minutesOf(plan.from);
  let to = minutesOf(plan.to);
  if (to <= from) to += 1440;
  const start = midnight + from * 60_000;
  const end = midnight + to * 60_000;
  const day = sunDay(midnight, latitude, longitude);
  // A timelapse into the small hours: the sunset is the first day's.
  const sunset = day.sunset;
  const local = (ms: number): Date => new Date(ms + offset * 60_000);
  const clockOf = (ms: number): string => {
    const t = local(ms);
    return clockWords(t.getUTCHours() * 60 + t.getUTCMinutes());
  };
  return {
    start,
    end,
    offset,
    sunset,
    clockOf,
    at(u: number) {
      const k = Math.min(1, Math.max(0, u));
      // To the second: an `at` is read to the second, so the sun moves smoothly from frame to frame.
      const ms = Math.round((start + (end - start) * k) / 1000) * 1000;
      const lamps = !plan.lightsAtDusk ? 0 : sunset === null ? (day.always === 'down' ? 1 : 0) : Math.min(1, Math.max(0, (ms - sunset) / LIGHTS_FADE_MS));
      return { ms, at: local(ms).toISOString().slice(0, 19), clock: clockOf(ms), sun: sunPlaceAt(ms, latitude, longitude), lamps };
    },
  };
}

const clockText = (minutes: number): string => {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/**
 * The preset for a day at a site: from two hours before its sunset to an hour after, each on the
 * half hour — so the sun is low and golden at the start, sets two thirds of the way through, and the
 * house is lit against the night at the end. Where the sun does not set that day, the board's own
 * half past four to half past nine.
 */
export function timelapseAround(date: string, site: { readonly latitude?: number | null; readonly longitude?: number | null } = {}): Timelapse {
  const plan: Timelapse = { date, ...DEFAULT_TIMELAPSE };
  const s = timelapseSchedule(plan, site);
  if (s.sunset === null) return plan;
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const midnight = Date.UTC(y, mo - 1, d) - s.offset * 60_000;
  const sunset = (s.sunset - midnight) / 60_000;
  return { ...plan, from: clockText(Math.floor((sunset - 120) / 30) * 30), to: clockText(Math.ceil((sunset + 60) / 30) * 30) };
}
