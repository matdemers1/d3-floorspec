/**
 * What each piece of a fixture's procedural model (FLR-T-12.21) or an opening's joinery (FLR-T-13.8)
 * is made of: a small set of roles — porcelain, stainless steel, a counter's stone, a lamp's lens, a
 * door's casing, a window's frame, its glass — and the one look each is drawn with, so the editor's
 * 3D view, the headless render, the path tracer and the glTF export colour a toilet, a range or a
 * French door the same way. A mesh is not normative (Core 0.5): these are a view's choices,
 * not the standard's, and a document's own materials are not involved.
 */

export const MODEL_ROLES = ['porcelain', 'stainless', 'darkMetal', 'wood', 'fabric', 'cushion', 'linen', 'stone', 'lens', 'trim', 'plate', 'glass', 'millwork', 'frame', 'door'] as const;
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
};
