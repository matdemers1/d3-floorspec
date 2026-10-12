/**
 * The plan's colours: `@d3cloud/ui` 1.5 tokens resolved to fixed hex per theme, so the SVG is
 * standalone (no CSS variables). The mapping follows the Floorspec (FLR) Figma board's plan canvas:
 * rooms on `surface-card`, wall poché in `fg`, separators in `border-float`, door leaves and swings
 * in `fg-faint`, windows in `info`, dimensions in `fg-muted`. The Floorspec accent marks what a
 * changeset adds or moves.
 */
export type ThemeName = 'light' | 'dark';

export interface Palette {
  /** --color-bg: the paper around the building. */
  readonly paper: string;
  /** --color-surface-card: room floors. */
  readonly room: string;
  /** --color-bg-sunken: unanchored faces. */
  readonly unanchored: string;
  /** --color-fg: wall poché and its outline. */
  readonly poche: string;
  /** --color-fg: primary text. */
  readonly text: string;
  /** --color-fg-muted: dimensions and secondary text. */
  readonly muted: string;
  /** --color-fg-faint: door leaves, swings, room IDs. */
  readonly faint: string;
  /** --color-border-float: separators. */
  readonly separator: string;
  /** --color-border: hatching. */
  readonly hairline: string;
  /** --color-info: window glazing. */
  readonly window: string;
  /** The Floorspec accent. */
  readonly accent: string;
  /** Text on the accent. */
  readonly accentInk: string;
  /** Ghosts of what a changeset removes or moves. */
  readonly ghost: string;
  /** --color-accent: a winder stair's tapered treads, tinted (drawn at a low opacity). */
  readonly winder: string;
  /** --color-warning: where the floor above a stair must be open from (Core 0.4, 17.6). */
  readonly opening: string;
  /** FS_landscape (FLR-T-13.5): a lawn, its edge, and a meadow. */
  readonly lawn: string;
  readonly lawnEdge: string;
  readonly meadow: string;
  /** A bed's cover, and its edging. */
  readonly bed: string;
  readonly edging: string;
  /** A path's or a stepping stone's stone, and a garden wall. */
  readonly paving: string;
  readonly gardenWall: string;
  /** A canopy, an evergreen's, and a grass's blades. */
  readonly canopy: string;
  readonly canopyDark: string;
  readonly grassInk: string;
}

/** The Floorspec accent, the same in both themes. */
export const ACCENT = '#b5d84a';

export const PALETTES: Readonly<Record<ThemeName, Palette>> = {
  light: {
    paper: '#f0f2f7',
    room: '#ffffff',
    unanchored: '#dbdee7',
    poche: '#101117',
    text: '#101117',
    muted: '#2c303b',
    faint: '#515563',
    separator: '#747888',
    hairline: '#b9bdcb',
    window: '#005896',
    accent: ACCENT,
    accentInk: '#101117',
    ghost: '#747888',
    winder: '#5432be',
    opening: '#714e00',
    lawn: '#e3ead6',
    lawnEdge: '#b9c7a3',
    meadow: '#ebecd2',
    bed: '#e9e1d4',
    edging: '#8a6a55',
    paving: '#dcdad4',
    gardenWall: '#a9a59d',
    canopy: '#6f8f4e',
    canopyDark: '#3f5d3a',
    grassInk: '#8c8a58',
  },
  dark: {
    paper: '#101117',
    room: '#1e212a',
    unanchored: '#080a0d',
    poche: '#f0f2f7',
    text: '#f0f2f7',
    muted: '#b9bdcb',
    faint: '#999ead',
    separator: '#747888',
    hairline: '#2c303b',
    window: '#87c3ff',
    accent: ACCENT,
    accentInk: '#101117',
    ghost: '#999ead',
    winder: '#978cff',
    opening: '#e7b45d',
    lawn: '#222b1d',
    lawnEdge: '#3a4a2e',
    meadow: '#2c2d1d',
    bed: '#2e2620',
    edging: '#a07c62',
    paving: '#3a3c40',
    gardenWall: '#6c6a66',
    canopy: '#8fb06a',
    canopyDark: '#6c9465',
    grassInk: '#b9b67a',
  },
};
