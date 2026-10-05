/**
 * Units. Floorspec lengths are integers of base units, 1/1280 mm (FLR-ADR-004); the solver works
 * on a 6-inch grid and multiplies out to base units only when it writes an operation, so every
 * coordinate it emits is an exact integer.
 */
export const BU_PER_INCH = 32_512;
export const BU_PER_FOOT = 390_144;
/** One square foot in square base units (Core §11.1). */
export const SQ_BU_PER_SQ_FT = 152_212_340_736;

/** The layout grid: 6 inches. Every room edge and every opening offset is a multiple of it or of an inch. */
export const GRID = 6 * BU_PER_INCH;
/** Grid units per foot. */
export const G_PER_FT = 2;
/** Square grid units per square foot. */
export const SQ_G_PER_SQ_FT = 4;

/** Feet to grid units, rounded up: a minimum dimension is never rounded below itself. */
export const ftG = (feet: number): number => Math.ceil(feet * G_PER_FT);
/** Inches to base units (exact for whole and half inches). */
export const inBu = (inches: number): number => Math.round(inches * BU_PER_INCH);
/** Grid units to base units. */
export const gBu = (g: number): number => g * GRID;
/** Grid units to feet. */
export const gFt = (g: number): number => g / G_PER_FT;
