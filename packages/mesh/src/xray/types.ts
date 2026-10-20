/**
 * X-ray's public shape (FLR-T-14.5): what is inside the walls, floors and ceilings, derived from the
 * document — never drawn by hand, never stored. View geometry: deterministic, in base units until
 * the one conversion to Float32 metres (`xrayMeshes`), but not normative.
 */

/**
 * The systems X-ray draws, each toggled on its own:
 *
 * | system | what |
 * |---|---|
 * | `framing` | each wall's core as studs (plates, king and jack studs, headers, rough sills, cripples) at its spacing; a solid core as a slab; sheathing (`substrate` layers) |
 * | `insulation` | batts in an insulated core's cavities, and continuous insulation (`insulation` layers) |
 * | `supply` | FS_plumbing's cold and hot water: from the water heater, under the floor, up the wall behind each fixture |
 * | `drain` | FS_plumbing's drains and vents: down the wall behind each fixture, under the floor to its stack; each fixture's vent up the wall; each stack |
 * | `electrical` | FS_electrical's circuits: from the panel along the walls at a fixed height, a drop to each device's box |
 * | `ducts` | FS_mechanical's ducts: from each piece of equipment to the terminals it serves, in the floor or the ceiling |
 */
export type XraySystem = 'framing' | 'insulation' | 'supply' | 'drain' | 'electrical' | 'ducts';

export const XRAY_SYSTEMS: readonly XraySystem[] = ['framing', 'insulation', 'supply', 'drain', 'electrical', 'ducts'];

/** A point, base units, the document's frame (x east, y north, z up). Floats: view geometry. */
export type P3 = readonly [number, number, number];

/**
 * A box in a frame on the plan: `o` its origin, `u` a unit vector along it, `v` = `u` turned 90°
 * anticlockwise (its left); `a` the range along `u`, `b` along `v`, `z` up.
 */
export interface FrameBox {
  readonly o: readonly [number, number];
  readonly u: readonly [number, number];
  readonly a: readonly [number, number];
  readonly b: readonly [number, number];
  readonly z: readonly [number, number];
}

/** How a piece is drawn: opaque, the dashes of a dashed pipe, or a translucent sheet (sheathing, insulation). */
export type XrayStyle = 'solid' | 'dash' | 'sheet';

/** One piece of a system: a member of a wall's framing, a batt, a run of pipe, cable or duct. */
export type XrayPiece = {
  readonly system: XraySystem;
  readonly level: string;
  /** What it is: `stud`, `king`, `jack`, `cripple`, `plate`, `header`, `sill`, `core`, `sheathing`, `batt`, `board`, `box`, or a run's kind. */
  readonly part: string;
  /** The element it belongs to: a wall, or the run's ID (XrayRun). */
  readonly owner: string;
  /** The wall it is in, for a wall's framing and a device's box. */
  readonly wall?: string;
} & (
  | { readonly shape: 'box'; readonly box: FrameBox; readonly sheet?: true }
  /** A round run (pipe, cable): its centreline, each segment horizontal or vertical, and its outside diameter. */
  | { readonly shape: 'tube'; readonly points: readonly P3[]; readonly diameter: number; readonly dashed?: true }
  /** A rectangular run (duct): its centreline and its section, `width` across and `height` up (a riser: `width` east–west). */
  | { readonly shape: 'duct'; readonly points: readonly P3[]; readonly width: number; readonly height: number }
);

/**
 * A run: one pipe, cable or duct a person would name — a fixture's cold or hot supply, its drain
 * or its vent, a stack, a circuit, a terminal's duct.
 */
export interface XrayRun {
  /** `<owner>:<kind>` (`KIT-SINK:cold`, `KIT-SINK:drain`), a stack's or a circuit's ID, `<terminal>:duct`. */
  readonly id: string;
  readonly system: Exclude<XraySystem, 'framing' | 'insulation'>;
  readonly kind: 'cold' | 'hot' | 'drain' | 'vent' | 'stack' | 'circuit' | 'supply' | 'return';
  /** The element it serves or is: a fixture, a water heater, a drain, a stack, a circuit, a terminal. */
  readonly owner: string;
  /** Nominal size, base units: a pipe's nominal diameter, a duct's width; a circuit's is 0 (its breaker is in `amps`). */
  readonly size: number;
  /** A circuit's breaker, amperes. */
  readonly amps?: number;
  readonly level: string;
  /** The walls it runs in, sorted. */
  readonly walls: readonly string[];
  /** Its centreline, base units. */
  readonly points: readonly P3[];
}

/** How a wall's core is framed, and where that came from. */
export interface XrayFraming {
  /** `studs` (members at a spacing), `solid` (one slab: masonry, concrete, panels), or `none` (an arc wall, not framed here). */
  readonly system: 'studs' | 'solid' | 'none';
  /** Centre to centre, base units (studs only). */
  readonly spacing?: number;
  /** Each member's width along the wall and depth across it, base units (studs only). */
  readonly member?: { readonly width: number; readonly depth: number; readonly designation?: string };
  /** `FS_structural`: the wall's own framing; `default`: none recorded, so 2x studs 16" on centre (FLR-ADR-056). */
  readonly source: 'FS_structural' | 'default';
}

/** What X-ray finds in one wall: its layers, its framing and what runs through it. */
export interface XrayWall {
  readonly id: string;
  readonly level: string;
  /** Its effective layers (5.4), left (exterior) face first. */
  readonly layers: readonly { readonly function: string; readonly thickness: number; readonly material?: string }[];
  /** The sum of its layers, base units. */
  readonly thickness: number;
  readonly framing: XrayFraming;
  /** Whether its core's cavities are insulated (batts). */
  readonly insulated: boolean;
  /** Common studs (the wall's ends included), king and jack studs, cripples, headers. */
  readonly studs: number;
  readonly kings: number;
  readonly jacks: number;
  readonly cripples: number;
  readonly headers: number;
  readonly batts: number;
  /** The openings framed in it. */
  readonly openings: readonly string[];
  /** The runs in it, by ID, sorted: supply, drains, vents, circuits, ducts. */
  readonly supply: readonly string[];
  readonly drain: readonly string[];
  readonly vent: readonly string[];
  readonly circuits: readonly string[];
  readonly ducts: readonly string[];
  /** The devices on its faces a circuit feeds, sorted. */
  readonly devices: readonly string[];
}

/** X-ray's derivation: every piece, every wall, every run, and how many of each system's things. */
export interface XrayPlan {
  readonly pieces: readonly XrayPiece[];
  readonly walls: Readonly<Record<string, XrayWall>>;
  readonly runs: readonly XrayRun[];
  readonly counts: {
    /** Studs of every kind: common, king, jack and cripple. */
    readonly studs: number;
    readonly batts: number;
    /** Supply runs: a fixture's cold or hot. */
    readonly supply: number;
    /** Drain runs (a fixture's, a water heater's, a drain's) and vents; stacks are counted in `stacks`. */
    readonly drain: number;
    readonly vents: number;
    readonly stacks: number;
    /** Circuits drawn: each with a placed panel and at least one placed load. */
    readonly circuits: number;
    /** Duct runs: a terminal's. */
    readonly ducts: number;
  };
}

/** One system's pieces on one level in one style, as a flat-shaded triangle list in metres. */
export interface XrayMesh {
  readonly system: XraySystem;
  readonly level: string;
  readonly style: XrayStyle;
  /** Float32 metres relative to the origin, three per vertex, three vertices per triangle (CCW from outside). */
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  /** How many pieces it holds. */
  readonly pieces: number;
}
