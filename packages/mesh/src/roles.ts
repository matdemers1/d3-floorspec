/**
 * What each piece of a fixture's procedural model (FLR-T-12.21) or an opening's joinery (FLR-T-13.8)
 * is made of: a small set of roles — porcelain, stainless steel, a counter's stone, a lamp's lens, a
 * door's casing, a window's frame, its glass — and the one look each is drawn with, so the editor's
 * 3D view, the headless render, the path tracer and the glTF export colour a toilet, a range or a
 * French door the same way. A mesh is not normative (Core 0.5): these are a view's choices,
 * not the standard's, and a document's own materials are not involved.
 */

export const MODEL_ROLES = [
  'porcelain', 'stainless', 'darkMetal', 'wood', 'fabric', 'cushion', 'linen', 'stone', 'lens', 'trim', 'plate', 'glass', 'millwork', 'frame', 'door',
  'foliage', 'foliageLight', 'foliageDark', 'trunk', 'grass', 'plume', 'lawn', 'meadow', 'mulch', 'barkMulch', 'soil', 'gravel', 'paver', 'concrete', 'corten', 'brick',
] as const;

/**
 * The roles only FS_landscape's models are made of (FLR-T-13.5): foliage, trunks, lawns, beds' covers
 * and hardscape. A view that draws a ground plane keeps these on top of it: a lawn's and a path's
 * surface stand a few millimetres above the ground they are laid on, never on it.
 */
export const LANDSCAPE_ROLES: readonly ModelRole[] = ['foliage', 'foliageLight', 'foliageDark', 'trunk', 'grass', 'plume', 'lawn', 'meadow', 'mulch', 'barkMulch', 'soil', 'gravel', 'paver', 'concrete', 'corten', 'brick'];
export type ModelRole = (typeof MODEL_ROLES)[number];

export interface RoleLook {
  /** `#rrggbb`, sRGB. */
  readonly color: string;
  /** 0–1, as glTF's metallic-roughness. */
  readonly metallic: number;
  readonly roughness: number;
  /** Drawn as if it gave light: unshaded in a raster view, glTF's emissive factor in an export. */
  readonly emissive?: true;
  /** Below 1: drawn see-through, as a window's glass is. */
  readonly opacity?: number;
}

/** Each role's look. */
export const ROLE_LOOKS: Readonly<Record<ModelRole, RoleLook>> = {
  /** A toilet, a basin, a tub, a white appliance's enamel. */
  porcelain: { color: '#f3f2ee', metallic: 0, roughness: 0.25 },
  /** A sink, a range, a refrigerator's doors, a tap. */
  stainless: { color: '#b4b9be', metallic: 0.85, roughness: 0.35 },
  /** Handles, grates, a lamp's shade, a toe kick's shadow, an outlet's slots. */
  darkMetal: { color: '#3b3e44', metallic: 0.6, roughness: 0.5 },
  /** Cabinets, tables, a bed's frame. */
  wood: { color: '#a77b52', metallic: 0, roughness: 0.6 },
  /** A sofa's body, a duvet. */
  fabric: { color: '#6e7b8c', metallic: 0, roughness: 0.95 },
  /** Seat cushions, pillows. */
  cushion: { color: '#8a97a8', metallic: 0, roughness: 0.95 },
  /** A mattress's sheets. */
  linen: { color: '#ece8de', metallic: 0, roughness: 0.9 },
  /** A counter top, a hearth. */
  stone: { color: '#d3cdc1', metallic: 0, roughness: 0.4 },
  /** What a luminaire shines through: bright, as if lit (lighting is FLR-T-12.22's). */
  lens: { color: '#fff6dc', metallic: 0, roughness: 0.3, emissive: true },
  /** A light's trim ring and canopy, a panel's door. */
  trim: { color: '#e4e1da', metallic: 0, roughness: 0.5 },
  /** A wall plate: a receptacle's, a switch's. */
  plate: { color: '#f6f5f1', metallic: 0, roughness: 0.45 },
  /**
   * A window's and a glazed door's glass, a shower's screen, a lantern's panes: faintly tinted, mostly
   * see-through. How it reflects and transmits light is FLR-T-13.7's; here it is a tinted pane.
   */
  glass: { color: '#bcd6e2', metallic: 0, roughness: 0.05, opacity: 0.35 },
  /** An opening's painted trim (FLR-T-13.8): its casing, the jambs lining it, a window's stool and apron. */
  millwork: { color: '#f1efe9', metallic: 0, roughness: 0.5 },
  /** A window's frame and sashes, a glazed door's stiles and rails, a garage door's sections: clad in dark aluminium. */
  frame: { color: '#3a3d42', metallic: 0.3, roughness: 0.45 },
  /** A door's slab, a pocket door, a bifold's panels: stained oak. */
  door: { color: '#9a7250', metallic: 0, roughness: 0.55 },
  // ─── FS_landscape (FLR-T-13.5): muted, layered greens, so a planting reads as one composition ───
  /** A canopy's or a shrub's main mass. */
  foliage: { color: '#58733f', metallic: 0, roughness: 0.9 },
  /** The sunlit lobes of a canopy, a groundcover's mat. */
  foliageLight: { color: '#7f9651', metallic: 0, roughness: 0.9 },
  /** The shaded lobes, an evergreen's and a conifer's needles. */
  foliageDark: { color: '#3a5434', metallic: 0, roughness: 0.9 },
  /** A tree's trunk. */
  trunk: { color: '#5e4c3e', metallic: 0, roughness: 0.85 },
  /** An ornamental grass's blades: sage turning to straw. */
  grass: { color: '#a6a571', metallic: 0, roughness: 0.9 },
  /** An ornamental grass's plumes. */
  plume: { color: '#d8cba0', metallic: 0, roughness: 0.9 },
  /** Mown turf. */
  lawn: { color: '#6b8d43', metallic: 0, roughness: 0.95 },
  /** Long grass, a meadow. */
  meadow: { color: '#98a35b', metallic: 0, roughness: 0.95 },
  /** A bed's shredded mulch. */
  mulch: { color: '#3f2f25', metallic: 0, roughness: 1 },
  /** A bed's bark mulch. */
  barkMulch: { color: '#5d3d29', metallic: 0, roughness: 1 },
  /** Bare soil, a planter's. */
  soil: { color: '#3b3029', metallic: 0, roughness: 1 },
  /** Gravel: a bed's cover, a path. */
  gravel: { color: '#c3baa7', metallic: 0, roughness: 0.95 },
  /** Stone pavers and stepping stones: bluestone grey. */
  paver: { color: '#9fa3a1', metallic: 0, roughness: 0.8 },
  /** Board-formed concrete: a planter's walls, a seat wall, a curb. */
  concrete: { color: '#c2beb5', metallic: 0, roughness: 0.85 },
  /** Weathering steel: edging, a planter. */
  corten: { color: '#8a4b2c', metallic: 0.3, roughness: 0.7 },
  /** Brick: edging, a path, a wall. */
  brick: { color: '#9a5a45', metallic: 0, roughness: 0.85 },
};
