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
  /** `preset`: a zone's preset as is; `custom`: the user changed at least one value; `assumed`: none set. */
  readonly source: 'preset' | 'custom' | 'assumed';
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
