/**
 * Where the sun is (FLR-T-8.6, FLR-REQ-123): the NOAA solar position algorithm — the formulas of
 * NOAA's Solar Calculator spreadsheet, which are Jean Meeus's low-accuracy solar coordinates
 * (Astronomical Algorithms, 2nd ed., ch. 25) with Smart's equation of time (ch. 28) and NOAA's
 * atmospheric refraction. NOAA states it good to about 0.01° in position for 1800–2100 between the
 * polar circles; the unit tests hold it to published reference values within 0.1°.
 *
 * Pure arithmetic on numbers, no clock and no time zone: an instant is UTC milliseconds since the
 * epoch (Date's own convention), angles in and out are degrees. ΔT (TT − UT, about a minute this
 * century) is ignored, as NOAA does — it moves the sun by about 0.004°.
 */

const RAD = Math.PI / 180;
const DAY_MS = 86_400_000;
/** The Julian day of the Unix epoch, 1970-01-01T00:00Z. */
const JD_EPOCH = 2_440_587.5;
/** J2000.0, 2000-01-01T12:00 TT. */
const J2000 = 2_451_545;

const mod = (a: number, n: number) => ((a % n) + n) % n;
const sin = (deg: number) => Math.sin(deg * RAD);
const cos = (deg: number) => Math.cos(deg * RAD);

/** The Julian day of an instant (UTC milliseconds). */
export function julianDay(ms: number): number {
  return ms / DAY_MS + JD_EPOCH;
}

/** An instant (UTC milliseconds) from a Julian day. */
export function instantOf(jd: number): number {
  return (jd - JD_EPOCH) * DAY_MS;
}

export interface SunCoordinates {
  /** The sun's apparent ecliptic longitude, degrees in [0, 360). */
  longitude: number;
  /** Apparent declination, degrees. */
  declination: number;
  /** The equation of time, minutes: apparent minus mean solar time. */
  equationOfTime: number;
}

/** The sun's apparent place at a Julian day (Meeus ch. 25, low accuracy; ch. 28 for the equation of time). */
export function sunCoordinates(jd: number): SunCoordinates {
  const t = (jd - J2000) / 36_525;
  const l0 = mod(280.46646 + t * (36_000.76983 + t * 0.0003032), 360);
  const m = 357.52911 + t * (35_999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const c = sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t)) + sin(2 * m) * (0.019993 - 0.000101 * t) + sin(3 * m) * 0.000289;
  const omega = 125.04 - 1934.136 * t;
  const lambda = l0 + c - 0.00569 - 0.00478 * sin(omega);
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * cos(omega);
  const declination = Math.asin(sin(eps) * sin(lambda)) / RAD;
  const y = Math.tan((eps / 2) * RAD) ** 2;
  const eot = y * sin(2 * l0) - 2 * e * sin(m) + 4 * e * y * sin(m) * cos(2 * l0) - 0.5 * y * y * sin(4 * l0) - 1.25 * e * e * sin(2 * m);
  return { longitude: mod(lambda, 360), declination, equationOfTime: (4 * eot) / RAD };
}

/** NOAA's refraction correction, degrees, for a geometric elevation in degrees. */
export function refraction(elevation: number): number {
  if (elevation > 85) return 0;
  const te = Math.tan(elevation * RAD);
  let arcsec: number;
  if (elevation > 5) arcsec = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
  else if (elevation > -0.575) arcsec = 1735 + elevation * (-518.2 + elevation * (103.4 + elevation * (-12.79 + elevation * 0.711)));
  else arcsec = -20.772 / te;
  return arcsec / 3600;
}

export interface SunPosition {
  /** Degrees clockwise from true north, [0, 360). */
  azimuth: number;
  /** Apparent altitude above the horizon, degrees, refraction included. */
  altitude: number;
  /** Altitude without refraction, degrees. */
  geometric: number;
  declination: number;
  equationOfTime: number;
  /** The hour angle, degrees: negative in the morning, positive after solar noon. */
  hourAngle: number;
}

/** The sun's position at a Julian day (UT) seen from a latitude and longitude (degrees, east positive). */
export function sunAtJulian(jd: number, latitude: number, longitude: number): SunPosition {
  const { declination, equationOfTime } = sunCoordinates(jd);
  // Minutes past 0h UT, then true solar time at the longitude.
  const minutes = mod(jd - 0.5, 1) * 1440;
  const solar = mod(minutes + equationOfTime + 4 * longitude, 1440);
  const hourAngle = solar / 4 < 0 ? solar / 4 + 180 : solar / 4 - 180;
  const cosZenith = Math.min(1, Math.max(-1, sin(latitude) * sin(declination) + cos(latitude) * cos(declination) * cos(hourAngle)));
  const zenith = Math.acos(cosZenith) / RAD;
  const geometric = 90 - zenith;
  // From north, clockwise: atan2 is well defined at the poles and at the zenith, where NOAA's acos is not.
  const azimuth = mod(Math.atan2(sin(hourAngle), cos(hourAngle) * sin(latitude) - Math.tan(declination * RAD) * cos(latitude)) / RAD + 180, 360);
  return { azimuth, altitude: geometric + refraction(geometric), geometric, declination, equationOfTime, hourAngle };
}

/** The sun's position at an instant (UTC milliseconds) seen from a latitude and longitude (degrees, east positive). */
export function sunAt(ms: number, latitude: number, longitude: number): SunPosition {
  return sunAtJulian(julianDay(ms), latitude, longitude);
}

/**
 * The unit vector towards the sun in the project's frame — x east, y north, z up, as Core 2.4 and
 * the 3D view draw it — given the site's true north (Core 1.8: the angle from project north, +Y, to
 * true north, counter-clockwise positive). True north is +Y turned by `trueNorth`; the sun's
 * azimuth turns clockwise from there.
 */
export function sunVector(azimuth: number, altitude: number, trueNorth: number): [number, number, number] {
  const a = azimuth - trueNorth;
  const h = cos(altitude);
  return [sin(a) * h, cos(a) * h, sin(altitude)];
}

export type Season = 'march' | 'june' | 'september' | 'december';

export const SEASONS: readonly { id: Season; label: string; short: string; longitude: number }[] = [
  { id: 'march', label: 'March equinox', short: 'Mar equinox', longitude: 0 },
  { id: 'june', label: 'June solstice', short: 'Jun solstice', longitude: 90 },
  { id: 'september', label: 'September equinox', short: 'Sep equinox', longitude: 180 },
  { id: 'december', label: 'December solstice', short: 'Dec solstice', longitude: 270 },
];

/**
 * The instant (UTC milliseconds) of an equinox or a solstice in a year: when the sun's apparent
 * longitude reaches 0°, 90°, 180° or 270° (Meeus ch. 27), found by bisection to under a second.
 */
export function seasonInstant(year: number, season: Season): number {
  const target = SEASONS.find((s) => s.id === season)?.longitude ?? 0;
  // Each falls within a few days of the 20th–23rd of its month.
  const month = { march: 2, june: 5, september: 8, december: 11 }[season];
  let lo = julianDay(Date.UTC(year, month, 15));
  let hi = julianDay(Date.UTC(year, month, 28));
  const ahead = (jd: number) => mod(sunCoordinates(jd).longitude - target + 180, 360) - 180;
  for (let i = 0; i < 50 && hi - lo > 1e-6; i++) {
    const mid = (lo + hi) / 2;
    if (ahead(mid) < 0) lo = mid;
    else hi = mid;
  }
  return instantOf((lo + hi) / 2);
}

/** The geometric altitude NOAA uses for sunrise and sunset: the upper limb on the horizon, refraction included. */
export const HORIZON = -0.833;

export interface SunDay {
  /** Solar noon, sunrise and sunset as UTC milliseconds; null when the sun does not rise or set that day. */
  noon: number;
  sunrise: number | null;
  sunset: number | null;
  /** Polar day or night. */
  always: 'up' | 'down' | null;
}

/**
 * Solar noon, sunrise and sunset in the 24 hours from `start` (UTC milliseconds, normally local
 * midnight at the site), found by scanning the sun's altitude and bisecting its crossings.
 */
export function sunDay(start: number, latitude: number, longitude: number): SunDay {
  const STEP = 10 * 60_000;
  const alt = (ms: number) => sunAt(ms, latitude, longitude).geometric;
  const bisect = (a: number, b: number, f: (ms: number) => number) => {
    for (let i = 0; i < 40 && b - a > 500; i++) {
      const mid = (a + b) / 2;
      if (Math.sign(f(mid)) === Math.sign(f(a))) a = mid;
      else b = mid;
    }
    return Math.round((a + b) / 2);
  };
  let sunrise: number | null = null;
  let sunset: number | null = null;
  let noon = start;
  let best = -Infinity;
  let up = false;
  let down = false;
  let prev = alt(start) - HORIZON;
  for (let t = start; t < start + DAY_MS; t += STEP) {
    const next = alt(t + STEP) - HORIZON;
    const here = prev + HORIZON;
    if (here > best) {
      best = here;
      noon = t;
    }
    if (prev > 0) up = true;
    else down = true;
    if (prev <= 0 && next > 0 && sunrise === null) sunrise = bisect(t, t + STEP, (ms) => alt(ms) - HORIZON);
    if (prev > 0 && next <= 0 && sunset === null) sunset = bisect(t, t + STEP, (ms) => alt(ms) - HORIZON);
    prev = next;
  }
  // Noon to the minute: the peak, by a golden-section search either side of the best sample.
  let a = noon - STEP;
  let b = noon + STEP;
  const g = (Math.sqrt(5) - 1) / 2;
  for (let i = 0; i < 40 && b - a > 500; i++) {
    const c = b - g * (b - a);
    const d = a + g * (b - a);
    if (alt(c) > alt(d)) b = d;
    else a = c;
  }
  noon = Math.round((a + b) / 2);
  return { noon, sunrise, sunset, always: up && !down ? 'up' : down && !up ? 'down' : null };
}

const POINTS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'] as const;

/** A compass point for an azimuth (degrees clockwise from true north). */
export function compassPoint(azimuth: number): (typeof POINTS)[number] {
  return POINTS[Math.round(mod(azimuth, 360) / 45) % 8] ?? 'north';
}
