/**
 * The public shape of a meshed document.
 *
 * Coordinates: Floorspec's own axes — x east, y north, z up (2.1) — never re-oriented. A three.js
 * scene, whose up is +y, rotates the house group by −90° about x (or sets `camera.up` to +z).
 */

/** Base units (1/1280 mm, FLR-ADR-004) in one metre: the one conversion from exact to float. */
export const UNITS_PER_METRE = 1_280_000;

export type Vec3 = [number, number, number];

/** An axis-aligned box. In `bbox` its corners are in base units and exact. */
export interface Box3 {
  min: Vec3;
  max: Vec3;
}

/**
 * What each part is. Solids (`closed: true`) are watertight, oriented 2-manifolds; surfaces
 * (`closed: false`) are one-sided sheets.
 *
 * | kind | element | closed |
 * |---|---|---|
 * | `wall` | wall | solid: its outline (5.7) from base to top (5.9), its openings cut through |
 * | `junctionFill` | junction | solid: the fill (5.7) from the least base to the greatest top of its walls |
 * | `opening` | opening | solid: exactly the volume cut from its wall — a pick target, glass, a door leaf's slot |
 * | `floor` | room | solid between its top and bottom (15.1); a surface facing up when it declares no thickness |
 * | `ceiling` | room | surface facing down: flat, tray (with its step) or vault (15.2–15.4) |
 * | `slab` | slab | solid (15.7) |
 * | `roof` | roof | solid: with a thickness, the surface thickened down by it; without, the shell closed by its gable ends and a soffit at the eave (16.5). A flat roof without thickness is a surface facing up |
 * | `roofGable` | roof | surface: a gable end (16.5), emitted only for a roof with a thickness, whose solid does not close it |
 * | `stairFlight` | stair | solid: one flight's treads, each from two risers below its top to its top, unioned — a winder stair's flights and its winders between them are one, and so are a spiral stair's treads (17.7) |
 * | `stairLanding` | stair | solid: a landing plate, by the same rule |
 * | `stairColumn` | stair | solid: a spiral stair's centre column, its column's radius (17.7) — or a slender pole when its treads meet at the centre — from its bottom to its top |
 * | `stairBlock` | stair | solid placeholder: the stair's box (17.4), for a winder or spiral stair whose steps are not derived (as a Core 0.3 reader reads it) |
 * | `extension` | extension element | solid: its fallback box (12.6) |
 */
export type PartKind =
  | 'wall'
  | 'junctionFill'
  | 'opening'
  | 'floor'
  | 'ceiling'
  | 'slab'
  | 'roof'
  | 'roofGable'
  | 'stairFlight'
  | 'stairLanding'
  | 'stairColumn'
  | 'stairBlock'
  | 'extension';

export const PART_KINDS: readonly PartKind[] = [
  'wall',
  'junctionFill',
  'opening',
  'floor',
  'ceiling',
  'slab',
  'roof',
  'roofGable',
  'stairFlight',
  'stairLanding',
  'stairColumn',
  'stairBlock',
  'extension',
];

/** An indexed triangle mesh in metres (Float32, relative to the result's `origin`), counter-clockwise seen from outside. */
export interface PartMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

/** The checks a caller asked for with `stats: true`, computed from the double-precision or exact source, not the Float32 output. */
export interface PartStats {
  /** Volume in cubic base units: exact for a part built from exact points, double-precision for one built by manifold-3d. */
  volume: number;
  /** True when `volume` is exact (as a double it may still be rounded: `volume6` is not). */
  exactVolume: boolean;
  /** Six times the exact volume, as a decimal integer, when `exactVolume`. */
  volume6?: string;
  /** The source geometry's bounding box in base units, before the Float32 conversion. */
  box: Box3;
  /** manifold-3d's genus, for a part built by it. */
  genus?: number;
}

export interface MeshPart {
  /** Unique within the result: the kind, the element ID, and the piece for a stair. */
  key: string;
  /** The Floorspec element this part belongs to: what a 3D selection selects in 2D. */
  id: string;
  kind: PartKind;
  /** The level of the element. */
  level: string;
  /** A watertight 2-manifold solid, or a surface. */
  closed: boolean;
  /** For a surface: which way it faces. */
  facing?: 'up' | 'down' | 'side';
  /** Set when the geometry stands in for what this draft does not derive (a roof's surface, a winder's steps). */
  placeholder?: true;
  /** A material the element references (roof, slab). */
  material?: string;
  /** A wall's layer materials, in the order of its layers (8.3); `null` for a layer without one. */
  layers?: (string | null)[];
  /** An opening's fill type and what it is. */
  opening?: { category: 'door' | 'window' | 'empty'; fill?: string; wall: string };
  /** An extension element's extension and collection. */
  extension?: { name: string; collection: string };
  mesh: PartMesh;
  /** Its bounding box in base units, from the exact geometry. Exact integers except where an opening's cut ends at a rational point. */
  bbox: Box3;
  stats?: PartStats;
}

export interface HouseMesh {
  unitsPerMetre: typeof UNITS_PER_METRE;
  /** Subtracted from every position before it is converted to metres, in base units. */
  origin: Vec3;
  parts: MeshPart[];
  /** The box of every part, in base units; null when there are none. */
  bbox: Box3 | null;
}

export interface MeshOptions {
  /** Only these levels' elements. Default: every level. */
  levels?: readonly string[];
  /** Only these kinds. Default: every kind. */
  include?: readonly PartKind[];
  /** In base units; default [0, 0, 0]. A view far from the document's origin passes its building's centre to keep Float32 precise. */
  origin?: Vec3;
  /** Attach `stats` to every part (for tests and diagnostics). */
  stats?: boolean;
}
