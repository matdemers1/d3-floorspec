/**
 * The assistant's heuristics: Floorspec's own round defaults for laying out a house's electrical
 * devices, every one configurable. They are a starting layout, chosen to be easy to read and to
 * change — they are not taken from any code, and nothing the assistant proposes says that a design
 * meets one. A jurisdiction's requirements are a Floorspec Rules pack's to state, with citations,
 * and its findings advise (FLR-ADR-011).
 *
 * Lengths are base units (1/1280 mm; 1 in = 32,512).
 */

const IN = 32_512;
const FT = 12 * IN;

export interface ElectricalDefaults {
  /** Along a wall run, receptacles at most this far apart, and the run's ends within half of it. */
  receptacleSpacing: number;
  /** A tighter spacing for rooms of a function: a kitchen's walls are taken as counter runs. */
  spacingByFunction: Readonly<Record<string, number>>;
  /** A wall run shorter than this — between a corner and a door, say — gets no receptacle. */
  minRun: number;
  /** From a corner or a door's edge to a receptacle's centre, at least. */
  endClearance: number;
  /** A receptacle's height above the wall's base, to its centre. */
  receptacleHeight: number;
  /** Heights for rooms of a function: above a counter or a vanity. */
  heightByFunction: Readonly<Record<string, number>>;
  /** Rooms of these functions get receptacles with GFCI at the device. */
  gfciFunctions: readonly string[];
  /** Circuits that serve rooms of these functions get AFCI at the breaker. */
  afciFunctions: readonly string[];
  /** A switch's height above the wall's base, to its centre. */
  switchHeight: number;
  /** A panel the assistant places when the plan has none (FLR-T-12.18): its centre's height, rating, spaces, and the least clear run it goes on. */
  panelHeight: number;
  panelRating: number;
  panelSpaces: number;
  panelMinRun: number;
  /** From the entry's edge to the switch's centre, beside it. */
  switchFromOpening: number;
  /** Rooms of these functions get no ceiling light. */
  noLightFunctions: readonly string[];
  /** Rooms of these functions get no receptacles. */
  noReceptacleFunctions: readonly string[];
  /** For grouping only: the load a receptacle is counted at, in watts. It is not written into the plan. */
  receptacleWatts: number;
  /** For grouping only: the load a light is counted at, in watts. */
  lightWatts: number;
  /** Receptacle circuits' breakers, in amperes. */
  receptacleBreaker: number;
  /** Lighting circuits' breakers, in amperes. */
  lightingBreaker: number;
  /** The nominal voltage of the circuits proposed. */
  volts: number;
  /** A circuit is filled to at most this fraction of its capacity (breaker × volts). */
  loadFraction: number;
  /** And to at most this many devices. */
  maxDevicesPerCircuit: number;
  /** Rooms of these functions get receptacle circuits of their own. */
  dedicatedFunctions: readonly string[];
  /** A kitchen gets at least this many receptacle circuits, its receptacles shared between them in turn. */
  kitchenCircuits: number;
  /** Positions along a wall and on a ceiling are rounded to this. */
  grid: number;
}

export const DEFAULTS: ElectricalDefaults = Object.freeze({
  receptacleSpacing: 12 * FT,
  spacingByFunction: Object.freeze({ kitchen: 4 * FT }),
  minRun: 2 * FT,
  endClearance: 6 * IN,
  receptacleHeight: 12 * IN,
  heightByFunction: Object.freeze({ kitchen: 42 * IN, bath: 36 * IN }),
  gfciFunctions: Object.freeze(['kitchen', 'bath', 'laundry', 'garage', 'utility', 'exterior']),
  afciFunctions: Object.freeze(['sleeping', 'living', 'dining', 'office', 'circulation', 'kitchen', 'laundry']),
  switchHeight: 48 * IN,
  panelHeight: 60 * IN,
  panelRating: 200,
  panelSpaces: 40,
  panelMinRun: 32 * IN,
  switchFromOpening: 6 * IN,
  noLightFunctions: Object.freeze(['exterior']),
  noReceptacleFunctions: Object.freeze(['storage', 'circulation']),
  receptacleWatts: 180,
  lightWatts: 60,
  receptacleBreaker: 20,
  lightingBreaker: 15,
  volts: 120,
  loadFraction: 0.8,
  maxDevicesPerCircuit: 10,
  dedicatedFunctions: Object.freeze(['kitchen', 'bath', 'laundry']),
  kitchenCircuits: 2,
  grid: IN,
});

/** The defaults with a caller's overrides; every override is checked, so a bad one fails loudly. */
export function withDefaults(overrides: Partial<ElectricalDefaults> = {}): ElectricalDefaults {
  const out = { ...DEFAULTS, ...overrides };
  const positive = ['receptacleSpacing', 'minRun', 'receptacleHeight', 'switchHeight', 'panelHeight', 'panelRating', 'panelSpaces', 'panelMinRun', 'receptacleBreaker', 'lightingBreaker', 'volts', 'maxDevicesPerCircuit', 'grid'] as const;
  for (const k of positive) if (!Number.isSafeInteger(out[k]) || out[k] <= 0) throw new RangeError(`${k} must be a whole number greater than zero`);
  for (const k of ['endClearance', 'switchFromOpening', 'receptacleWatts', 'lightWatts', 'kitchenCircuits'] as const)
    if (!Number.isSafeInteger(out[k]) || out[k] < 0) throw new RangeError(`${k} must be a whole number, zero or more`);
  if (!(out.loadFraction > 0 && out.loadFraction <= 1)) throw new RangeError('loadFraction must be more than 0 and at most 1');
  for (const [f, v] of [...Object.entries(out.spacingByFunction), ...Object.entries(out.heightByFunction)])
    if (!Number.isSafeInteger(v) || v <= 0) throw new RangeError(`the value for ${f} must be a whole number greater than zero`);
  return out;
}
