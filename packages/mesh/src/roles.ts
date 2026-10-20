/**
 * What each piece of a fixture's procedural model (FLR-T-12.21) or an opening's joinery (FLR-T-13.8)
 * is made of: a small set of roles — porcelain, stainless steel, a counter's stone, a lamp's lens, a
 * door's casing, a window's frame, its glass — and the one look each is drawn with, so the editor's
 * 3D view, the headless render, the path tracer and the glTF export colour a toilet, a range or a
 * French door the same way. A mesh is not normative (Core 0.5): these are a view's choices,
 * not the standard's, and a document's own materials are not involved.
 */

import { LAWN_TINT, SNOW_ALBEDO } from './sky/weather.js';

/** `#rrggbb` (sRGB) times a linear multiplier per channel, back to `#rrggbb`. */
function tinted(hex: string, k: readonly [number, number, number]): string {
  const n = parseInt(hex.slice(1), 16);
  return (
    '#' +
    [(n >> 16) & 255, (n >> 8) & 255, n & 255]
      .map((v, i) => {
        const c = v / 255;
        const lin = (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * k[i]!;
        const t = Math.min(1, Math.max(0, lin));
        return Math.round(255 * (t <= 0.0031308 ? 12.92 * t : 1.055 * t ** (1 / 2.4) - 0.055))
          .toString(16)
          .padStart(2, '0');
      })
      .join('')
  );
}

export const MODEL_ROLES = [
  'porcelain', 'stainless', 'darkMetal', 'wood', 'fabric', 'cushion', 'linen', 'stone', 'lens', 'trim', 'plate', 'glass', 'millwork', 'frame', 'door',
  'foliage', 'foliageLight', 'foliageDark', 'trunk', 'grass', 'plume', 'lawn', 'meadow', 'mulch', 'barkMulch', 'soil', 'gravel', 'paver', 'concrete', 'corten', 'brick',
  // Decor (FLR-T-13.11): a rug's wool, glazes and planters, a picture's canvas and its muted accents, a lamp's shade, brass, a screen, a mirror — leaves are the landscape's foliage.
  'rug', 'rugBorder', 'ceramic', 'terracotta', 'canvas', 'clay', 'ochre', 'sage', 'slate', 'shade', 'brass', 'screen', 'mirror',
  // Seasons and weather (FLR-T-15.4, looks.ts): a deciduous plant's spring leaves and blossom, its autumn
  // colours and the leaves it drops, a lawn and a meadow through the year, and a light snow.
  'leafSpring', 'leafSpringLight', 'blossom', 'autumnGold', 'autumnOrange', 'autumnRed', 'autumnBrown',
  'lawnSpring', 'lawnAutumn', 'lawnWinter', 'meadowSpring', 'meadowAutumn', 'meadowWinter', 'snow',
] as const;

/**
 * The roles only FS_landscape's models are made of (FLR-T-13.5): foliage, trunks, lawns, beds' covers
 * and hardscape. A view that draws a ground plane keeps these on top of it: a lawn's and a path's
 * surface stand a few millimetres above the ground they are laid on, never on it.
 */
export const LANDSCAPE_ROLES: readonly ModelRole[] = ['foliage', 'foliageLight', 'foliageDark', 'trunk', 'grass', 'plume', 'lawn', 'meadow', 'mulch', 'barkMulch', 'soil', 'gravel', 'paver', 'concrete', 'corten', 'brick'];

/** The roles only decor is made of (FLR-T-13.11), and the foliage its plants share with the landscape: a house without the starter library's decor has none of them. */
export const DECOR_ROLES: readonly ModelRole[] = ['rug', 'rugBorder', 'foliage', 'ceramic', 'terracotta', 'canvas', 'clay', 'ochre', 'sage', 'slate', 'shade', 'brass', 'screen', 'mirror'];
export type ModelRole = (typeof MODEL_ROLES)[number];

/**
 * The roles only a season or a weather draws (FLR-T-15.4, looks.ts): no model is made of them — a look
 * swaps a plant's or a lawn's role for one of these, and lays snow in `snow`.
 */
export const LOOK_ROLES: readonly ModelRole[] = [
  'leafSpring', 'leafSpringLight', 'blossom', 'autumnGold', 'autumnOrange', 'autumnRed', 'autumnBrown',
  'lawnSpring', 'lawnAutumn', 'lawnWinter', 'meadowSpring', 'meadowAutumn', 'meadowWinter', 'snow',
];

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
   * A window's and a glazed door's glass, a shower's screen, a lantern's panes: clear float glass, its
   * faint green the iron in it. Every view draws it by glass.ts — about 90% through, more reflected and
   * a little greener seen at a slant; `opacity` only marks it see-through.
   */
  glass: { color: '#dde9e3', metallic: 0, roughness: 0.05, opacity: 0.35 },
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
  /** An ornamental grass's young blades, the upright heart of the clump; its arching skirt is `meadow`. */
  grass: { color: '#748c4a', metallic: 0, roughness: 0.9 },
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
  // ─── Decor (FLR-T-13.11): a quiet, warm palette, every accent muted ───
  /** A rug's wool field: oatmeal. */
  rug: { color: '#cdbfa6', metallic: 0, roughness: 1 },
  /** A rug's border, a dark cushion: ink. */
  rugBorder: { color: '#3c424e', metallic: 0, roughness: 1 },
  /** A white glaze: a vase, a bowl, a lamp's base, a planter. */
  ceramic: { color: '#eeeae2', metallic: 0, roughness: 0.3 },
  /** An unglazed planter. */
  terracotta: { color: '#ad6b4b', metallic: 0, roughness: 0.85 },
  /** A picture's mat, a book's pages. */
  canvas: { color: '#eee8dc', metallic: 0, roughness: 0.9 },
  /** The accents — a picture's colours, a cushion's, a throw's, a book's: clay, ochre, sage and slate. */
  clay: { color: '#b37a5e', metallic: 0, roughness: 0.9 },
  ochre: { color: '#c8a35e', metallic: 0, roughness: 0.85 },
  sage: { color: '#8f9d85', metallic: 0, roughness: 0.85 },
  slate: { color: '#5a636e', metallic: 0, roughness: 0.85 },
  /** A lamp's shade and bulb: parchment, lit from within. */
  shade: { color: '#f4ebd8', metallic: 0, roughness: 0.9, emissive: true },
  /** A lamp's stem, a picture's frame, a curtain rod, a towel bar: brushed brass. */
  brass: { color: '#b4935f', metallic: 0.85, roughness: 0.3 },
  /** A television's screen, off. */
  screen: { color: '#0e0f11', metallic: 0.3, roughness: 0.08 },
  /** A mirror's glass. */
  mirror: { color: '#d3d9dc', metallic: 1, roughness: 0.04 },
  // ─── Seasons and weather (FLR-T-15.4) ───
  /** A deciduous canopy's fresh spring leaves, and their sunlit lobes. */
  leafSpring: { color: '#77a046', metallic: 0, roughness: 0.9 },
  leafSpringLight: { color: '#a3c46a', metallic: 0, roughness: 0.9 },
  /** A flowering tree's blossom. */
  blossom: { color: '#efd3db', metallic: 0, roughness: 0.9 },
  /** Autumn colour: gold, orange, red, and the browning lobes. */
  autumnGold: { color: '#d39a2b', metallic: 0, roughness: 0.9 },
  autumnOrange: { color: '#c5642a', metallic: 0, roughness: 0.9 },
  autumnRed: { color: '#a5342a', metallic: 0, roughness: 0.9 },
  autumnBrown: { color: '#7c4d2b', metallic: 0, roughness: 0.92 },
  /** A lawn and a meadow through the year: summer's colour times the season's (sky/weather.ts LAWN_TINT). */
  lawnSpring: { color: tinted('#6b8d43', LAWN_TINT.spring), metallic: 0, roughness: 0.95 },
  lawnAutumn: { color: tinted('#6b8d43', LAWN_TINT.autumn), metallic: 0, roughness: 0.95 },
  lawnWinter: { color: tinted('#6b8d43', LAWN_TINT.winter), metallic: 0, roughness: 0.95 },
  meadowSpring: { color: tinted('#98a35b', LAWN_TINT.spring), metallic: 0, roughness: 0.95 },
  meadowAutumn: { color: tinted('#98a35b', LAWN_TINT.autumn), metallic: 0, roughness: 0.95 },
  meadowWinter: { color: tinted('#98a35b', LAWN_TINT.winter), metallic: 0, roughness: 0.95 },
  /** A light snow on what faces up outside (SNOW_ALBEDO, in sRGB). */
  snow: { color: tinted('#ffffff', SNOW_ALBEDO), metallic: 0, roughness: 0.85 },
};
