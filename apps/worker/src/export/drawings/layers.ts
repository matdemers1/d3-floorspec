/**
 * Layer names in the pattern of the US National CAD Standard's layer guidelines (FLR-REQ-130):
 * a discipline designator, a hyphen, a four-letter major group, and optional four-letter minor
 * groups — `A-WALL-EXTR`, `A-DOOR`, `E-POWR-DEVC`. The names are composed by that pattern for
 * what Floorspec draws; no table is copied.
 *
 * Colours are AutoCAD Color Index numbers and weights are hundredths of a millimetre, chosen so the
 * DXF plots as a legible plan with no plot-style table: walls heavy, openings medium,
 * annotation light.
 */

export interface LayerDef {
  readonly name: string;
  /** ACI colour, 1–255. */
  readonly color: number;
  /** Lineweight in 1/100 mm (a DXF lineweight enum value). */
  readonly weight: number;
  readonly linetype: 'CONTINUOUS' | 'DASHED' | 'HIDDEN';
  readonly description: string;
}

export const LAYERS = {
  wallExterior: 'A-WALL-EXTR',
  wallInterior: 'A-WALL-INTR',
  door: 'A-DOOR',
  doorTag: 'A-DOOR-IDEN',
  glazing: 'A-GLAZ',
  glazingTag: 'A-GLAZ-IDEN',
  roomBoundary: 'A-AREA',
  roomLabel: 'A-AREA-IDEN',
  separator: 'A-AREA-BNDY',
  floor: 'A-FLOR-OTLN',
  dims: 'A-ANNO-DIMS',
  note: 'A-ANNO-NOTE',
  symbol: 'A-ANNO-SYMB',
  equipment: 'A-EQPM',
  stair: 'A-FLOR-STRS',
  stairAbove: 'A-FLOR-STRS-OVHD',
  stairTag: 'A-FLOR-STRS-IDEN',
  roofAbove: 'A-ROOF-OVHD',
  roofOutline: 'A-ROOF-OTLN',
  roofRidge: 'A-ROOF-RIDG',
  roofValley: 'A-ROOF-VLLY',
  roofTag: 'A-ROOF-IDEN',
} as const;

const DEFS: readonly LayerDef[] = [
  { name: LAYERS.wallExterior, color: 7, weight: 50, linetype: 'CONTINUOUS', description: 'Exterior walls, cut' },
  { name: LAYERS.wallInterior, color: 7, weight: 35, linetype: 'CONTINUOUS', description: 'Interior walls, cut' },
  { name: LAYERS.door, color: 2, weight: 25, linetype: 'CONTINUOUS', description: 'Doors: leaves and swings' },
  { name: LAYERS.doorTag, color: 2, weight: 18, linetype: 'CONTINUOUS', description: 'Door marks' },
  { name: LAYERS.glazing, color: 4, weight: 25, linetype: 'CONTINUOUS', description: 'Windows: frames and glazing' },
  { name: LAYERS.glazingTag, color: 4, weight: 18, linetype: 'CONTINUOUS', description: 'Window marks' },
  { name: LAYERS.roomBoundary, color: 8, weight: 13, linetype: 'CONTINUOUS', description: 'Room boundaries (net, derived)' },
  { name: LAYERS.roomLabel, color: 3, weight: 18, linetype: 'CONTINUOUS', description: 'Room names, areas and sizes' },
  { name: LAYERS.separator, color: 8, weight: 18, linetype: 'DASHED', description: 'Room separation lines' },
  { name: LAYERS.floor, color: 9, weight: 18, linetype: 'CONTINUOUS', description: 'Slab outlines' },
  { name: LAYERS.dims, color: 1, weight: 18, linetype: 'CONTINUOUS', description: 'Dimension strings' },
  { name: LAYERS.note, color: 1, weight: 25, linetype: 'CONTINUOUS', description: 'Notes: not for construction' },
  { name: LAYERS.symbol, color: 7, weight: 25, linetype: 'CONTINUOUS', description: 'North arrow' },
  { name: LAYERS.equipment, color: 6, weight: 18, linetype: 'CONTINUOUS', description: 'Other equipment (extension fallbacks)' },
  { name: LAYERS.stair, color: 7, weight: 25, linetype: 'CONTINUOUS', description: 'Stairs: treads, landings, the cut line and its break' },
  { name: LAYERS.stairAbove, color: 8, weight: 18, linetype: 'HIDDEN', description: 'Stairs above the cut plane' },
  { name: LAYERS.stairTag, color: 7, weight: 18, linetype: 'CONTINUOUS', description: 'Stair arrows: UP from the foot, DN from the head' },
  { name: LAYERS.roofAbove, color: 8, weight: 25, linetype: 'DASHED', description: 'Roof eave above the plan (overhead)' },
  { name: LAYERS.roofOutline, color: 7, weight: 50, linetype: 'CONTINUOUS', description: 'Roof plan: eave outline and gable ends' },
  { name: LAYERS.roofRidge, color: 7, weight: 35, linetype: 'CONTINUOUS', description: 'Roof plan: ridges and hips' },
  { name: LAYERS.roofValley, color: 7, weight: 35, linetype: 'CONTINUOUS', description: 'Roof plan: valleys' },
  { name: LAYERS.roofTag, color: 3, weight: 18, linetype: 'CONTINUOUS', description: 'Roof plan: slope arrows and pitches' },
  { name: 'E-POWR-DEVC', color: 1, weight: 18, linetype: 'CONTINUOUS', description: 'Receptacles and power devices' },
  { name: 'E-POWR-PANL', color: 1, weight: 25, linetype: 'CONTINUOUS', description: 'Panels' },
  { name: 'E-POWR-EQPM', color: 1, weight: 18, linetype: 'CONTINUOUS', description: 'Power equipment' },
  { name: 'E-LITE-FIXT', color: 1, weight: 18, linetype: 'CONTINUOUS', description: 'Light fixtures' },
  { name: 'E-LITE-SWCH', color: 1, weight: 18, linetype: 'CONTINUOUS', description: 'Switches' },
  { name: 'E-FIRE-DEVC', color: 1, weight: 18, linetype: 'CONTINUOUS', description: 'Smoke and CO alarms' },
  { name: 'P-FIXT', color: 5, weight: 18, linetype: 'CONTINUOUS', description: 'Plumbing fixtures' },
  { name: 'P-EQPM', color: 5, weight: 18, linetype: 'CONTINUOUS', description: 'Plumbing equipment' },
  { name: 'M-HVAC-EQPM', color: 6, weight: 18, linetype: 'CONTINUOUS', description: 'HVAC equipment' },
  { name: 'M-HVAC-DEVC', color: 6, weight: 18, linetype: 'CONTINUOUS', description: 'Registers, grilles and thermostats' },
  { name: 'T-COMM-DEVC', color: 30, weight: 18, linetype: 'CONTINUOUS', description: 'Low-voltage outlets and devices' },
  { name: 'I-FURN', color: 8, weight: 13, linetype: 'CONTINUOUS', description: 'Furniture' },
  { name: 'S-EQPM', color: 8, weight: 18, linetype: 'CONTINUOUS', description: 'Structural elements' },
];

/** Every layer the drawings may use, in the order the DXF declares them. */
export const LAYER_DEFS: readonly LayerDef[] = DEFS;

const BY_COLLECTION: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  FS_electrical: {
    receptacles: 'E-POWR-DEVC',
    evChargers: 'E-POWR-EQPM',
    panels: 'E-POWR-PANL',
    lights: 'E-LITE-FIXT',
    switches: 'E-LITE-SWCH',
    alarms: 'E-FIRE-DEVC',
    '*': 'E-POWR-DEVC',
  },
  FS_plumbing: { fixtures: 'P-FIXT', '*': 'P-EQPM' },
  FS_mechanical: { equipment: 'M-HVAC-EQPM', '*': 'M-HVAC-DEVC' },
  FS_lowvoltage: { '*': 'T-COMM-DEVC' },
  FS_furniture: { '*': 'I-FURN' },
  FS_structural: { '*': 'S-EQPM' },
};

/** The layer an extension element's fallback box is drawn on: by discipline, then by collection. */
export function layerForDevice(extension: string, collection: string): string {
  const table = BY_COLLECTION[extension];
  if (table === undefined) return LAYERS.equipment;
  return table[collection] ?? table['*'] ?? LAYERS.equipment;
}

/** True when a name follows the pattern: discipline, major group, up to two minor groups. */
export function isNcsName(name: string): boolean {
  return /^[A-Z]-[A-Z]{4}(-[A-Z]{4}){0,2}$/.test(name);
}
