/**
 * The Floorspec thermal library (FLR-T-16.4, FLR-ADR-066): what common building materials conduct and
 * store, as FS_thermal 0.1.0 data (registry/FS_thermal/spec.md 2.1) ready to write onto a document's
 * material — and, where a document says nothing, the typical value an advisory estimate falls back to,
 * saying so.
 *
 * Released under CC0 1.0: every value is a typical, rounded figure for the generic material — never a
 * product's rating — compiled for this library and cited to the public-domain sources it agrees with:
 * the U.S. National Institute of Standards and Technology's Heat Transmission Properties of Insulating
 * and Building Materials (NIST SRD 81) and the U.S. Department of Energy's Building America House
 * Simulation Protocols (NREL), both works of the U.S. Government. A product's own datasheet beats
 * any value here; the citation on each written material says where it came from.
 *
 * Units are FS_thermal's (1.5): conductivity in mW/(m·K); a stated resistance in thousandths of
 * m²·K/W; density kg/m³; specific heat J/(kg·K); reflectance and emittance in thousandths.
 */

/** What a library material is, for grouping and for the analysis's assumptions. */
export type ThermalCategory = 'cladding' | 'sheathing' | 'insulation' | 'cavity' | 'framing' | 'air' | 'membrane' | 'masonry' | 'concrete' | 'finish' | 'flooring' | 'roofing' | 'metal' | 'glass';

export interface ThermalLibraryItem {
  readonly id: string;
  readonly name: string;
  readonly category: ThermalCategory;
  /** mW/(m·K); absent when the item states a resistance. */
  readonly conductivity?: number;
  /** Thousandths of m²·K/W, whatever the layer's thickness (an air space, a membrane). */
  readonly resistance?: number;
  readonly density: number;
  readonly specificHeat: number;
  readonly solarReflectance?: number;
  readonly emittance?: number;
  /** Where the item's values agree with: one of SOURCES' keys. */
  readonly source: keyof typeof SOURCES;
  /** Material IDs and library items (the US starter library's, @floorspec/mesh's material library's) it stands for. */
  readonly matches: readonly string[];
  /** A cavity: the insulation (or air) between studs, joists or rafters — the layer a framing replaces. */
  readonly cavity?: boolean;
}

export const THERMAL_LIBRARY_VERSION = '0.1.0';
export const THERMAL_LIBRARY_LICENSE = 'CC0-1.0';

/** The public-domain sources the library's values are cited to. */
export const SOURCES = {
  nist: 'NIST SRD 81, Heat Transmission Properties of Insulating and Building Materials (U.S. Government work)',
  ba: 'U.S. DOE Building America House Simulation Protocols, NREL (U.S. Government work)',
  both: 'NIST SRD 81 and the U.S. DOE Building America House Simulation Protocols, NREL (U.S. Government works)',
} as const;

/** The citation written onto a material from the library. */
export const citationOf = (item: ThermalLibraryItem): string =>
  `Floorspec thermal library ${THERMAL_LIBRARY_VERSION} (CC0 1.0), ${item.id}: typical value, rounded; cf. ${SOURCES[item.source]}`;

export const THERMAL_LIBRARY: readonly ThermalLibraryItem[] = [
  // Cladding and roofing: their surfaces matter for FLR-T-16.5 (reflectance, emittance).
  { id: 'fibre-cement', name: 'Fibre-cement siding', category: 'cladding', conductivity: 250, density: 1300, specificHeat: 1000, solarReflectance: 300, emittance: 900, source: 'both', matches: ['fibre-cement-siding', 'lap-siding', 'board-and-batten', 'shiplap-v-groove'] },
  { id: 'wood-siding', name: 'Wood siding', category: 'cladding', conductivity: 120, density: 500, specificHeat: 1630, solarReflectance: 250, emittance: 900, source: 'both', matches: ['cedar-shakes'] },
  { id: 'brick', name: 'Brick, common', category: 'masonry', conductivity: 720, density: 1920, specificHeat: 800, solarReflectance: 300, emittance: 900, source: 'both', matches: ['brick-veneer', 'brick-red-running', 'brick-whitewashed', 'brick-buff-roman', 'brick-herringbone-paver'] },
  { id: 'stucco', name: 'Stucco, cement', category: 'cladding', conductivity: 720, density: 1860, specificHeat: 840, solarReflectance: 400, emittance: 900, source: 'nist', matches: ['stucco'] },
  { id: 'stone', name: 'Stone, natural', category: 'masonry', conductivity: 2300, density: 2500, specificHeat: 840, solarReflectance: 350, emittance: 900, source: 'nist', matches: ['stacked-stone', 'bluestone-pavers', 'granite-salt-pepper', 'marble-carrara', 'slate-roof'] },
  { id: 'standing-seam-steel', name: 'Steel roofing, painted', category: 'roofing', conductivity: 50000, density: 7800, specificHeat: 450, solarReflectance: 250, emittance: 850, source: 'nist', matches: ['standing-seam', 'standing-seam-metal'] },
  { id: 'asphalt-shingles', name: 'Asphalt shingles', category: 'roofing', conductivity: 80, density: 1100, specificHeat: 1260, solarReflectance: 100, emittance: 900, source: 'both', matches: ['asphalt-shingles'] },
  { id: 'clay-tile', name: 'Clay roof tile', category: 'roofing', conductivity: 840, density: 1900, specificHeat: 840, solarReflectance: 350, emittance: 900, source: 'nist', matches: ['clay-barrel-tile', 'terracotta-tile'] },
  // Sheathing and boards.
  { id: 'osb', name: 'OSB sheathing', category: 'sheathing', conductivity: 100, density: 650, specificHeat: 1880, source: 'both', matches: ['osb-sheathing'] },
  { id: 'plywood', name: 'Plywood', category: 'sheathing', conductivity: 120, density: 545, specificHeat: 1880, source: 'both', matches: ['plywood', 'plywood-sheathing', 'plywood-subfloor'] },
  { id: 'gypsum-board', name: 'Gypsum board', category: 'finish', conductivity: 160, density: 800, specificHeat: 1090, source: 'both', matches: ['gypsum-board', 'plaster-smooth'] },
  { id: 'lime-plaster', name: 'Lime plaster', category: 'finish', conductivity: 700, density: 1600, specificHeat: 840, source: 'nist', matches: ['limewash-sand', 'limewash-plaster'] },
  { id: 'wood-fibre-board', name: 'Wood-fibre insulation board', category: 'insulation', conductivity: 38, density: 160, specificHeat: 2100, source: 'nist', matches: ['wood-fibre-board'] },
  // Insulation.
  { id: 'mineral-wool-batt', name: 'Mineral-wool batt', category: 'insulation', conductivity: 35, density: 40, specificHeat: 840, source: 'both', matches: ['mineral-wool-batt'], cavity: true },
  { id: 'fibreglass-batt', name: 'Fibreglass batt', category: 'insulation', conductivity: 40, density: 12, specificHeat: 840, source: 'both', matches: ['fibreglass-batt', 'wood-stud-framing-insulated'], cavity: true },
  { id: 'cellulose', name: 'Cellulose, blown', category: 'insulation', conductivity: 40, density: 50, specificHeat: 1380, source: 'both', matches: ['cellulose'], cavity: true },
  { id: 'eps', name: 'Expanded polystyrene (EPS)', category: 'insulation', conductivity: 36, density: 20, specificHeat: 1300, source: 'both', matches: ['eps'] },
  { id: 'xps', name: 'Extruded polystyrene (XPS)', category: 'insulation', conductivity: 29, density: 30, specificHeat: 1300, source: 'both', matches: ['xps', 'rigid-foam-insulation'] },
  { id: 'polyiso', name: 'Polyisocyanurate board', category: 'insulation', conductivity: 23, density: 30, specificHeat: 1470, source: 'both', matches: ['polyiso'] },
  { id: 'spray-foam-closed', name: 'Spray foam, closed cell', category: 'insulation', conductivity: 24, density: 32, specificHeat: 1470, source: 'both', matches: ['spray-foam-closed'], cavity: true },
  { id: 'spray-foam-open', name: 'Spray foam, open cell', category: 'insulation', conductivity: 37, density: 8, specificHeat: 1470, source: 'both', matches: ['spray-foam-open'], cavity: true },
  // Framing and cavities.
  { id: 'softwood-framing', name: 'Softwood framing lumber', category: 'framing', conductivity: 120, density: 450, specificHeat: 1630, source: 'both', matches: ['spf-framing', 'wood-framing'] },
  { id: 'empty-stud-cavity', name: 'Stud cavity, empty (air)', category: 'cavity', resistance: 160, density: 1, specificHeat: 1005, source: 'both', matches: ['wood-stud-framing'], cavity: true },
  // Air spaces and membranes: a resistance stated whole (FS_thermal 2.1).
  { id: 'rainscreen-gap', name: 'Ventilated rainscreen gap', category: 'air', resistance: 35, density: 1, specificHeat: 1005, source: 'both', matches: ['rainscreen-gap', 'air-space-ventilated'] },
  { id: 'air-space', name: 'Air space, unventilated, ¾–4 in', category: 'air', resistance: 170, density: 1, specificHeat: 1005, source: 'both', matches: ['air-space'] },
  { id: 'vented-attic', name: 'Vented attic', category: 'air', resistance: 300, density: 1, specificHeat: 1005, source: 'ba', matches: ['vented-attic'] },
  { id: 'housewrap', name: 'Housewrap (weather-resistive barrier)', category: 'membrane', resistance: 0, density: 400, specificHeat: 1300, source: 'both', matches: ['weather-resistive-barrier', 'housewrap'] },
  // Masonry, concrete and floors.
  { id: 'concrete', name: 'Concrete, normal weight', category: 'concrete', conductivity: 1700, density: 2300, specificHeat: 900, solarReflectance: 350, emittance: 900, source: 'both', matches: ['cast-in-place-concrete', 'concrete-smooth', 'concrete-broom', 'concrete-pavers', 'rectangular-pavers'] },
  { id: 'cmu-hollow', name: 'Concrete masonry units, hollow', category: 'masonry', conductivity: 970, density: 1100, specificHeat: 880, solarReflectance: 350, emittance: 900, source: 'nist', matches: ['concrete-masonry-unit'] },
  { id: 'hardwood-floor', name: 'Hardwood flooring', category: 'flooring', conductivity: 160, density: 720, specificHeat: 1630, source: 'both', matches: ['white-oak-plank', 'smoked-oak-plank', 'oak-herringbone', 'white-oak-floor', 'cedar-tongue-groove', 'cedar-ceiling', 'ipe-decking', 'composite-decking', 'white-oak-veneer', 'walnut-veneer'] },
  { id: 'ceramic-tile', name: 'Ceramic or porcelain tile', category: 'flooring', conductivity: 1300, density: 2300, specificHeat: 840, source: 'nist', matches: ['porcelain-warm-stone', 'porcelain-tile-stone', 'subway-white', 'zellige-green', 'square-white-gloss', 'terrazzo-white', 'terrazzo', 'quartz-white'] },
  { id: 'carpet', name: 'Carpet and pad', category: 'flooring', conductivity: 60, density: 200, specificHeat: 1300, source: 'nist', matches: ['carpet-wool-beige'] },
  { id: 'epoxy', name: 'Epoxy floor coating', category: 'flooring', conductivity: 200, density: 1200, specificHeat: 1100, source: 'nist', matches: ['epoxy-floor', 'garage-epoxy'] },
  // Metals and glass.
  { id: 'steel', name: 'Steel', category: 'metal', conductivity: 50000, density: 7800, specificHeat: 450, source: 'nist', matches: ['stainless-brushed', 'steel-blackened'] },
  { id: 'aluminium', name: 'Aluminium', category: 'metal', conductivity: 160000, density: 2700, specificHeat: 900, source: 'nist', matches: ['aluminium-anodised'] },
  { id: 'copper', name: 'Copper', category: 'metal', conductivity: 390000, density: 8900, specificHeat: 385, source: 'nist', matches: ['copper', 'brass-satin'] },
  { id: 'glass', name: 'Glass, soda-lime', category: 'glass', conductivity: 1000, density: 2500, specificHeat: 840, source: 'nist', matches: ['glass-clear', 'glass-frosted', 'glass-bronze'] },
];

const BY_ID = new Map(THERMAL_LIBRARY.map((i) => [i.id, i]));
const BY_MATCH = new Map(THERMAL_LIBRARY.flatMap((i) => i.matches.map((m) => [m, i] as const)));

/** An item by its own ID. */
export const thermalItem = (id: string): ThermalLibraryItem | undefined => BY_ID.get(id);

/** The item a material stands for: by the material's own ID, else its library `source.item` — or none. */
export function thermalMatch(materialId: string, material: unknown): ThermalLibraryItem | undefined {
  const direct = BY_ID.get(materialId) ?? BY_MATCH.get(materialId);
  if (direct) return direct;
  const item = (material as { source?: { item?: unknown } } | null)?.source?.item;
  return typeof item === 'string' ? (BY_ID.get(item) ?? BY_MATCH.get(item)) : undefined;
}

/** An item as the FS_thermal data a material carries (spec 2.1), with its citation. */
export function thermalData(item: ThermalLibraryItem): Record<string, number | string> {
  return {
    ...(item.conductivity === undefined ? {} : { conductivity: item.conductivity }),
    ...(item.resistance === undefined ? {} : { resistance: item.resistance }),
    density: item.density,
    specificHeat: item.specificHeat,
    ...(item.solarReflectance === undefined ? {} : { solarReflectance: item.solarReflectance }),
    ...(item.emittance === undefined ? {} : { emittance: item.emittance }),
    citation: citationOf(item),
  };
}
