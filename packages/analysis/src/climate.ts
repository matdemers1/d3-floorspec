/**
 * The climate an estimate is made for: the outdoor design temperatures, the degree days of a typical
 * year, the indoor set points, and the latitude the sun is worked out at.
 *
 * Nothing here reaches the network. The user picks a climate-zone preset or types their own values;
 * a plan with neither is estimated for the 4A preset, and the estimate says so.
 *
 * The presets are rounded values for one representative city in each IECC climate zone, in °F as
 * the sources publish them: the 99% heating and 1% cooling dry-bulb temperatures of the ASHRAE
 * Handbook — Fundamentals climatic design data, and heating and cooling degree days to a 65 °F base
 * from the NOAA 1991–2020 U.S. climate normals. They are deliberately coarse — one city stands for
 * a whole zone — and the screen says to replace them with the site's own values.
 */

/** °F → °C. */
export const fToC = (f: number): number => ((f - 32) * 5) / 9;
/** °C → °F. */
export const cToF = (c: number): number => (c * 9) / 5 + 32;
/** °F·days → °C·days. */
export const fDaysToC = (fd: number): number => (fd * 5) / 9;

export interface ClimatePreset {
  /** The IECC climate zone: "4A". */
  readonly zone: string;
  /** The city whose values stand for the zone. */
  readonly city: string;
  /** In words: "mixed-humid". */
  readonly kind: string;
  /** 99% heating dry bulb, °F. */
  readonly heatingF: number;
  /** 1% cooling dry bulb, °F. */
  readonly coolingF: number;
  /** Degree days, 65 °F base, °F·days. */
  readonly hddF: number;
  readonly cddF: number;
}

/** One representative city per zone; rounded (see the module comment for the sources). */
export const CLIMATE_PRESETS: readonly ClimatePreset[] = [
  { zone: '1A', city: 'Miami', kind: 'very hot, humid', heatingF: 47, coolingF: 91, hddF: 120, cddF: 4500 },
  { zone: '2A', city: 'Houston', kind: 'hot, humid', heatingF: 32, coolingF: 95, hddF: 1300, cddF: 3100 },
  { zone: '2B', city: 'Phoenix', kind: 'hot, dry', heatingF: 37, coolingF: 108, hddF: 900, cddF: 4700 },
  { zone: '3A', city: 'Atlanta', kind: 'warm, humid', heatingF: 24, coolingF: 92, hddF: 2700, cddF: 1800 },
  { zone: '3B', city: 'Las Vegas', kind: 'warm, dry', heatingF: 30, coolingF: 106, hddF: 2100, cddF: 3600 },
  { zone: '3C', city: 'San Francisco', kind: 'warm, marine', heatingF: 39, coolingF: 83, hddF: 2600, cddF: 150 },
  { zone: '4A', city: 'Baltimore', kind: 'mixed, humid', heatingF: 15, coolingF: 92, hddF: 4600, cddF: 1200 },
  { zone: '4B', city: 'Albuquerque', kind: 'mixed, dry', heatingF: 18, coolingF: 94, hddF: 4100, cddF: 1300 },
  { zone: '4C', city: 'Seattle', kind: 'mixed, marine', heatingF: 26, coolingF: 84, hddF: 4600, cddF: 250 },
  { zone: '5A', city: 'Chicago', kind: 'cool, humid', heatingF: -2, coolingF: 89, hddF: 6200, cddF: 900 },
  { zone: '5B', city: 'Denver', kind: 'cool, dry', heatingF: 3, coolingF: 92, hddF: 5900, cddF: 800 },
  { zone: '6A', city: 'Minneapolis', kind: 'cold, humid', heatingF: -11, coolingF: 89, hddF: 7600, cddF: 750 },
  { zone: '7', city: 'Duluth', kind: 'very cold', heatingF: -17, coolingF: 84, hddF: 9600, cddF: 200 },
  { zone: '8', city: 'Fairbanks', kind: 'subarctic', heatingF: -40, coolingF: 82, hddF: 13900, cddF: 80 },
];

/** The preset a plan with no climate of its own is estimated for. */
export const ASSUMED_ZONE = '4A';

export const presetOf = (zone: string): ClimatePreset | undefined => CLIMATE_PRESETS.find((p) => p.zone === zone);

/** The thermal-zone number of a preset, for the assembly defaults: "4A" → 4, "7" → 7. */
export const zoneNumber = (zone: string): number => Number.parseInt(zone, 10);

/** Indoor set points: 70 °F in winter and 75 °F in summer, the usual design conditions. */
export const INDOOR_WINTER_C = fToC(70);
export const INDOOR_SUMMER_C = fToC(75);
/** The latitude the sun is worked out at when the site has no location: about the middle of the contiguous US. */
export const ASSUMED_LATITUDE = 40;

/** A climate as the estimate uses it: SI, every value with where it came from. */
export interface Climate {
  /** `preset`: a zone's preset as is; `custom`: the user changed at least one value; `site`: the station nearest the site's location (FLR-T-16.4); `assumed`: none set and no station near. */
  readonly source: 'preset' | 'custom' | 'site' | 'assumed';
  /** The station the values are from, and how far it is from the site, when `source` is `site` (or a custom climate started from it). */
  readonly station?: { readonly city: string; readonly km: number };
  /** The preset the values start from. */
  readonly zone: string;
  /** "Zone 4A preset · mixed, humid, Baltimore-like". */
  readonly label: string;
  /** °C. */
  readonly heatingDesign: number;
  readonly coolingDesign: number;
  /** °C·days, 18.3 °C (65 °F) base. */
  readonly hdd: number;
  readonly cdd: number;
  readonly indoorWinter: number;
  readonly indoorSummer: number;
  /** Degrees north (negative south). */
  readonly latitude: number;
  readonly latitudeSource: 'site' | 'assumed';
}

/**
 * Design conditions by place (FLR-T-16.4): a site's latitude and longitude (Core 1.8) → the nearest of
 * these stations, its IECC climate zone and its design temperatures and degree days, so that a plan
 * with a location is estimated for its own climate without anyone choosing a preset.
 *
 * The values are rounded — whole °F, degree days to the hundred — from the same sources as the
 * presets: the ASHRAE Handbook — Fundamentals climatic design data (99% heating and 1% cooling dry
 * bulb) and the NOAA 1991–2020 U.S. climate normals (65 °F base), with each county's IECC 2021 zone.
 * The fourteen preset cities are stations too, with the presets' own values. A station far from the
 * site stands for it less well; the climate's label says how far it is, and the screen says to
 * replace the values with the site's own.
 */
export interface Station {
  readonly city: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly zone: string;
  readonly heatingF: number;
  readonly coolingF: number;
  readonly hddF: number;
  readonly cddF: number;
}

export const STATIONS: readonly Station[] = [
  { city: 'Miami, FL', latitude: 25.79, longitude: -80.29, zone: '1A', heatingF: 47, coolingF: 91, hddF: 120, cddF: 4500 },
  { city: 'Houston, TX', latitude: 29.98, longitude: -95.36, zone: '2A', heatingF: 32, coolingF: 95, hddF: 1300, cddF: 3100 },
  { city: 'New Orleans, LA', latitude: 29.99, longitude: -90.25, zone: '2A', heatingF: 35, coolingF: 93, hddF: 1300, cddF: 3000 },
  { city: 'Phoenix, AZ', latitude: 33.43, longitude: -112.01, zone: '2B', heatingF: 37, coolingF: 108, hddF: 900, cddF: 4700 },
  { city: 'Atlanta, GA', latitude: 33.64, longitude: -84.43, zone: '3A', heatingF: 24, coolingF: 92, hddF: 2700, cddF: 1800 },
  { city: 'Dallas, TX', latitude: 32.9, longitude: -97.04, zone: '3A', heatingF: 25, coolingF: 99, hddF: 2100, cddF: 2900 },
  { city: 'Charlotte, NC', latitude: 35.21, longitude: -80.94, zone: '3A', heatingF: 23, coolingF: 92, hddF: 3100, cddF: 1700 },
  { city: 'Las Vegas, NV', latitude: 36.08, longitude: -115.15, zone: '3B', heatingF: 30, coolingF: 106, hddF: 2100, cddF: 3600 },
  { city: 'Los Angeles, CA', latitude: 33.94, longitude: -118.41, zone: '3B', heatingF: 43, coolingF: 84, hddF: 1200, cddF: 700 },
  { city: 'San Francisco, CA', latitude: 37.62, longitude: -122.37, zone: '3C', heatingF: 39, coolingF: 83, hddF: 2600, cddF: 150 },
  { city: 'Baltimore, MD', latitude: 39.18, longitude: -76.67, zone: '4A', heatingF: 15, coolingF: 92, hddF: 4600, cddF: 1200 },
  { city: 'New York, NY', latitude: 40.78, longitude: -73.97, zone: '4A', heatingF: 15, coolingF: 90, hddF: 4600, cddF: 1200 },
  { city: 'Nashville, TN', latitude: 36.12, longitude: -86.68, zone: '4A', heatingF: 19, coolingF: 93, hddF: 3600, cddF: 1700 },
  { city: 'Kansas City, MO', latitude: 39.3, longitude: -94.71, zone: '4A', heatingF: 6, coolingF: 95, hddF: 5000, cddF: 1400 },
  { city: 'Albuquerque, NM', latitude: 35.04, longitude: -106.61, zone: '4B', heatingF: 18, coolingF: 94, hddF: 4100, cddF: 1300 },
  { city: 'Seattle, WA', latitude: 47.45, longitude: -122.31, zone: '4C', heatingF: 26, coolingF: 84, hddF: 4600, cddF: 250 },
  { city: 'Portland, OR', latitude: 45.59, longitude: -122.6, zone: '4C', heatingF: 26, coolingF: 89, hddF: 4300, cddF: 400 },
  { city: 'Chicago, IL', latitude: 41.98, longitude: -87.9, zone: '5A', heatingF: -2, coolingF: 89, hddF: 6200, cddF: 900 },
  { city: 'Boston, MA', latitude: 42.36, longitude: -71.01, zone: '5A', heatingF: 9, coolingF: 88, hddF: 5600, cddF: 750 },
  { city: 'Denver, CO', latitude: 39.85, longitude: -104.66, zone: '5B', heatingF: 3, coolingF: 92, hddF: 5900, cddF: 800 },
  { city: 'Salt Lake City, UT', latitude: 40.79, longitude: -111.97, zone: '5B', heatingF: 10, coolingF: 97, hddF: 5600, cddF: 1200 },
  { city: 'Minneapolis, MN', latitude: 44.88, longitude: -93.23, zone: '6A', heatingF: -11, coolingF: 89, hddF: 7600, cddF: 750 },
  { city: 'Duluth, MN', latitude: 46.84, longitude: -92.19, zone: '7', heatingF: -17, coolingF: 84, hddF: 9600, cddF: 200 },
  { city: 'Fairbanks, AK', latitude: 64.8, longitude: -147.88, zone: '8', heatingF: -40, coolingF: 82, hddF: 13900, cddF: 80 },
];

/** Great-circle distance, km. */
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The station nearest a place, and how far it is; ties go to the first listed. */
export function nearestStation(latitude: number, longitude: number): { station: Station; km: number } {
  let best = STATIONS[0]!;
  let km = Infinity;
  for (const s of STATIONS) {
    const d = distanceKm(latitude, longitude, s.latitude, s.longitude);
    if (d < km) {
      best = s;
      km = d;
    }
  }
  return { station: best, km };
}

/** How near a station must be to stand for a site: farther, and the climate is assumed. */
export const STATION_RANGE_KM = 250;
