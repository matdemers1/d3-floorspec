/**
 * The public shape of a meshed document.
 *
 * Coordinates: Floorspec's own axes — x east, y north, z up (2.1) — never re-oriented. A three.js
 * scene, whose up is +y, rotates the house group by −90° about x (or sets `camera.up` to +z).
 */
import type { ModelRole } from './roles.js';

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
 * | `junctionFill` | junction | solid: the fill (5.7) from the least base to the greatest top of its walls; and, as the piece `closure:<wall>`, the corner a separator between two walls leaves open (see closures.ts) |
 * | `opening` | opening | solid: exactly the volume cut from its wall — a pick target, glass, a door leaf's slot |
 * | `floor` | room | solid between its top and bottom (15.1); a surface facing up when it declares no thickness — or, on a level with a level below, a solid down to just above the ceiling below (`plenum`), a surface facing both ways where that leaves no depth (FLR-T-12.32) |
 * | `ceiling` | room | surface facing down: flat, tray (with its step) or vault (15.2–15.4) — none of it inside a room of a higher level whose floor it is above, a bridge in a double-height room (FLR-T-12.37) |
 * | `slab` | slab | solid (15.7) |
 * | `roof` | roof | solid: with a thickness, the surface thickened down by it, raking past its gable ends; without, the volume between the eave and the surface over the whole eave outline, closed by a soffit at the eave and, along each gable's edge of the outline, the surface's edge dropped to the eave (16.5). A flat roof without thickness is a surface facing up |
 * | `roofGable` | roof | surface: a gable end (16.5) — on its wall, the gable's edge of the footprint, in Core 0.4 — emitted only for a roof with a thickness, whose solid does not close it: the part below the solid's underside; clad as the wall it stands on (`cladding`) |
 * | `stairFlight` | stair | solid: one flight's treads, each from two risers below its top to its top, unioned — a winder stair's flights and its winders between them are one, and so are a spiral stair's treads (17.7) |
 * | `stairLanding` | stair | solid: a landing plate, by the same rule |
 * | `stairColumn` | stair | solid: a spiral stair's centre column, its column's radius (17.7) — or a slender pole when its treads meet at the centre — from its bottom to its top |
 * | `stairBlock` | stair | solid placeholder: the stair's box (17.4), for a winder or spiral stair whose steps are not derived (as a Core 0.3 reader reads it) |
 * | `extension` | extension element | solid: its fallback box (12.6) — or, for an element this reader models, each piece of its model (`model`), inside that box. None for an element an FS_furniture appliance stands for (`standsFor`, FLR-T-12.34) |
 * | `threshold` | opening | a door's or an empty opening's sill where it is its wall's base: the plan its cut removes, each side of the location line, as the floor of the room on that side — solid between its top and bottom, a surface facing up without a thickness, and drawn down as that floor is (`plenum`) (see thresholds.ts) |
 * | `joinery` | opening | solid: one piece of what fills it (FLR-T-13.8) — the jambs lining it and its casings; a door's slabs with their hinges and handles, by its operation; a window's frame, sashes and glass, its stool, apron and sill — each with its `model` (the operation and what the piece is made of) and, for a piece that moves, the doors `state` it is drawn in (see joinery.ts) |
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
  | 'extension'
  | 'threshold'
  | 'joinery';

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
  'threshold',
  'joinery',
];

/**
 * A floor that declares no thickness (15.1) on a level with a level below, as a view draws it
 * (FLR-T-12.32, rooms.ts `plenumsOf`): down from its top to `bottom` — just above the highest ceiling
 * below it — so it is seen from below and closes the band between that ceiling and the floor.
 */
export interface Plenum {
  /** Base units, an integer: the bottom of the solid; its top where there is no depth to fill (a surface facing both ways). */
  bottom: number;
  /** The room of a lower level it covers most, whose ceiling its underside is (18.6: its ceiling finish); absent over none. */
  room?: string;
}

/**
 * What a gable end is clad in (FLR-T-12.38, cladding.ts): the wall under it, the side of that wall
 * that looks out of the roof (5.4), and the material that face is finished in (18.6) — absent when
 * none resolves, and the face's default colour (appearance.ts `face`) is drawn.
 */
export interface Cladding {
  wall: string;
  side: 'left' | 'right';
  material?: string;
}

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
  /** For a surface: which way it faces — `both` for a floor drawn down to a ceiling it has no depth above (`plenum`). */
  facing?: 'up' | 'down' | 'side' | 'both';
  /** Set when the geometry stands in for what this draft does not derive (a roof's surface, a winder's steps). */
  placeholder?: true;
  /** A material the element references (roof, slab). */
  material?: string;
  /**
   * A gable end's wall (FLR-T-12.38): the wall of the roof's level it stands on, and that wall's face
   * looking out of the roof, whose finish it is drawn in. Absent where no wall runs along its edge.
   */
  cladding?: Cladding;
  /** A wall's layer materials, in the order of its layers (8.3); `null` for a layer without one. */
  layers?: (string | null)[];
  /** An opening's fill type and what it is. */
  opening?: { category: 'door' | 'window' | 'empty'; fill?: string; wall: string };
  /** A floor (or a threshold, as its room's floor) drawn down to the ceiling below (FLR-T-12.32). */
  plenum?: Plenum;
  /** A threshold's wall, the side of its location line, and the room whose floor it continues. */
  threshold?: { wall: string; side: 'left' | 'right'; room: string };
  /** An extension element's extension and collection. */
  extension?: { name: string; collection: string };
  /**
   * The elements an FS_furniture appliance's parts also stand for (FLR-T-12.34): the FS_plumbing
   * fixture or FS_mechanical gas appliance paired with it — in its box, named in its `connections`
   * or the same appliance — which draws no part of its own. By ID. Selecting one of them selects
   * these parts in 3D.
   */
  standsFor?: string[];
  /**
   * A piece of an extension element's procedural model (FLR-T-12.21): what the element is (its
   * collection's discriminant — `waterCloset`, `recessed`, `baseCabinet` — or the collection's name)
   * and what this piece is made of (ROLE_LOOKS); `smooth` for a round piece — a solid of revolution,
   * which a view may draw as one curved surface. Absent on an element drawn as its fallback box.
   */
  model?: { kind: string; role: ModelRole; smooth?: true };
  /**
   * A piece of a door's joinery that moves (FLR-T-13.8) — a slab, a sliding panel, a garage door's
   * sections — and the state it is drawn in: closed, or open (swung to 90°, slid, folded, raised).
   * Only with `doors: 'both'` does a mesh hold pieces in both; absent on every piece that does not move.
   */
  state?: DoorState;
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
  /** Draw the extension elements this reader models as their models (default); false draws every one as its fallback box. */
  models?: boolean;
  /**
   * The doors as a view shows them (FLR-T-13.8): `closed` (default), `open` — swung to 90°, slid
   * into their pockets or past their openings, folded, raised — or `both`, every moving piece drawn
   * each way with its `state`, for a view that switches between them without meshing again.
   */
  doors?: DoorState | 'both';
}

/** Whether a door is drawn closed or open (FLR-T-13.8). */
export type DoorState = 'closed' | 'open';
