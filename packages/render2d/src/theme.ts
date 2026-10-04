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
  },
};
