/**
 * Plan styles (FLR-T-18.5): one theme for every place a plan is drawn — the editor's canvas,
 * `renderPlan` (floorspec_render's `style`), and the PDF drawings — so a Colour plan is the same
 * plan wherever it is seen. After the Floorspec (FLR) board's "18.5 · Plan styles" frames:
 *
 * - **Colour** — floors in their finish's colour with a pattern at true scale (planks along their
 *   direction, tile with its grout, terrazzo's chips, pavers in running bond, a slab's joints), walls
 *   a solid poché, furniture in colour, lawn and paving outside, room names on pills;
 * - **Presentation** — Colour with charcoal walls and a soft shadow under the walls and furniture:
 *   the still sent to a client;
 * - **Technical** — black and white with a line-weight hierarchy (walls › doors › furniture ›
 *   hatches), exterior walls hatched and interior walls solid, wet rooms gridded, patios hatched,
 *   names in capitals;
 * - **Blueprint** — Technical's hierarchy in white on blueprint blue over a 2 ft grid.
 *
 * Each has a light and a dark theme. A dark colour plan pulls every material colour 38 % toward the
 * canvas so it does not glare (the P18 read-me's decision). Construction mode defaults to Technical.
 *
 * Patterns are derived, not sampled: a floor's pattern comes from its material — the material
 * library's item (FLR-T-13.6) where the material names one, else the words of its name — at the
 * item's true size, scaled with the material's own texture size and turned by its texture's rotation.
 * Vector patterns stay crisp at every zoom, follow the theme, and are the same bytes every time.
 * Pure data and string-building: no Node APIs, no trigonometry in what is written.
 */
import { num } from './format.js';
import { el, type XY } from './svg.js';
import { ACCENT, PALETTES, type Palette, type ThemeName } from './theme.js';
import type { ModeId } from './modes.js';

export const PLAN_STYLES = ['colour', 'presentation', 'technical', 'blueprint'] as const;
export type PlanStyle = (typeof PLAN_STYLES)[number];

export const isPlanStyle = (v: unknown): v is PlanStyle => typeof v === 'string' && (PLAN_STYLES as readonly string[]).includes(v);

export interface StyleDef {
  readonly id: PlanStyle;
  readonly label: string;
  /** What it draws, in a few words: the style menu's second line. */
  readonly summary: string;
}

export const STYLES: Readonly<Record<PlanStyle, StyleDef>> = {
  colour: { id: 'colour', label: 'Colour', summary: 'Floors and furniture in colour' },
  presentation: { id: 'presentation', label: 'Presentation', summary: 'Colour + soft shadows, charcoal walls' },
  technical: { id: 'technical', label: 'Technical', summary: 'B&W, line weights, hatches' },
  blueprint: { id: 'blueprint', label: 'Blueprint', summary: 'White on blue' },
};

/** The style a plan is drawn in when none is chosen: Technical for Construction, Colour otherwise. */
export const defaultStyle = (mode?: ModeId | null): PlanStyle => (mode === 'construction' ? 'technical' : 'colour');

/** How far a dark colour plan pulls each material colour toward the canvas. */
export const DARK_PULL = 0.38;

/** A style's parts a person can turn off (the Plan style panel's "Details"). */
export interface StyleDetails {
  /** Presentation's soft shadows. */
  readonly shadows: boolean;
  /** Floor patterns at true scale; off, a floor is its colour alone. */
  readonly patterns: boolean;
  /** Furniture in colour; off, in the plan's ink. */
  readonly furniture: boolean;
  /** Room names on pills. */
  readonly pills: boolean;
  /** Lawn, paving and planting in colour. */
  readonly landscape: boolean;
}

export const ALL_DETAILS: StyleDetails = { shadows: true, patterns: true, furniture: true, pills: true, landscape: true };

// ── colour arithmetic, in sRGB hex ───────────────────────────────────────────

const rgb = (hex: string): [number, number, number] => {
  const h = /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#808080';
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
};
const hex2 = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

/** `a` moved `t` of the way to `b`. */
export function mix(a: string, b: string, t: number): string {
  const x = rgb(a);
  const y = rgb(b);
  return `#${hex2(x[0] + (y[0] - x[0]) * t)}${hex2(x[1] + (y[1] - x[1]) * t)}${hex2(x[2] + (y[2] - x[2]) * t)}`;
}

/** Lighter (k > 0, toward white) or darker (k < 0, toward black). */
export const shade = (c: string, k: number): string => (k >= 0 ? mix(c, '#ffffff', k) : mix(c, '#000000', -k));

/** WCAG relative luminance. */
export function luminance(c: string): number {
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgb(c);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio of two colours. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

// ── the theme ────────────────────────────────────────────────────────────────

/**
 * A style in a theme: the plan's palette (every colour render2d's legacy drawing reads, so the
 * landscape and symbol code draws in the style unchanged) and what the style adds.
 */
export interface PlanTheme extends Palette {
  readonly style: PlanStyle;
  readonly theme: ThemeName;
  /** Floors and furniture in their colours (Colour, Presentation). */
  readonly colour: boolean;
  /** Line drawing in one ink (Technical, Blueprint). */
  readonly linework: boolean;
  /** Wall poché: exterior and interior walls, and the edge drawn round them. */
  readonly wallExterior: string;
  readonly wallInterior: string;
  readonly wallEdge: string;
  /** Exterior walls are hatched in this ink over the paper (Technical, Blueprint), not filled solid. */
  readonly wallHatch: string | null;
  /** A window's glass, between its lines. */
  readonly glass: string;
  /** A door's threshold: the floor drawn through an opening. */
  readonly threshold: string;
  readonly door: string;
  readonly swing: string;
  /** A stair's treads. */
  readonly tread: string;
  /** The pill under a room's name, when names sit on pills. */
  readonly pill: { readonly fill: string; readonly opacity: number; readonly stroke: string } | null;
  /** Names in capitals, spaced (Technical, Blueprint). */
  readonly caps: boolean;
  /** Presentation's soft shadow. */
  readonly shadow: { readonly color: string; readonly opacity: number; readonly blur: number; readonly dy: number } | null;
  /** Blueprint's grid: its ink, its opacity and its spacing in base units (2 ft). */
  readonly grid: { readonly color: string; readonly opacity: number; readonly every: number } | null;
  /** Line weights in pixels, heaviest first: walls › doors › furniture › hatches. */
  readonly weights: { readonly wall: number; readonly door: number; readonly furniture: number; readonly hatch: number };
  /** The ground round the house when the site has no lawn of its own: a backdrop. */
  readonly site: string | null;
  /** The plain floor of a room with no finish. */
  readonly floorPlain: string;
}

/** 2 ft in base units: Blueprint's grid. */
const TWO_FT = 2 * 390_144;

const LIGHT = PALETTES.light;
const DARK = PALETTES.dark;

/** The contrast the plan's text keeps over every floor a style draws (WCAG AA, normal text). */
export const TEXT_CONTRAST = 4.5;

/**
 * A floor's tone moved just far enough that the plan's text reads on it at 4.5:1: toward black under
 * light text (the dark theme), toward white under dark text (the light theme). Most finishes do not
 * move; a pale stone in the dark theme or a dark wood in the light one does, so a room's name, a
 * device's tag or a stair's UP never sinks into its floor.
 */
export function legibleUnder(tone: string, text: string): string {
  if (contrast(text, tone) >= TEXT_CONTRAST) return tone;
  const toward = luminance(text) > 0.5 ? '#000000' : '#ffffff';
  for (let k = 1; k <= 50; k++) {
    const c = mix(tone, toward, k / 50);
    if (contrast(text, c) >= TEXT_CONTRAST) return c;
  }
  return toward;
}

function colourTheme(style: 'colour' | 'presentation', theme: ThemeName): PlanTheme {
  const dark = theme === 'dark';
  const base = dark ? DARK : LIGHT;
  const pres = style === 'presentation';
  const walls = dark ? (pres ? '#2c2f37' : '#e9e6df') : pres ? '#3b3e45' : '#2a2c33';
  const t = (c: string): string => legibleUnder(dark ? mix(c, base.paper, DARK_PULL) : c, base.text);
  return {
    ...base,
    style,
    theme,
    colour: true,
    linework: false,
    // A room with no finish: the warm white of a colour plan, or in the dark theme the card's own dark.
    room: dark ? '#262931' : t('#f4f1ea'),
    floorPlain: dark ? '#262931' : t('#f4f1ea'),
    poche: walls,
    wallExterior: walls,
    wallInterior: walls,
    wallEdge: dark && pres ? '#5d616c' : walls,
    wallHatch: null,
    window: dark ? '#7fb2e5' : '#3a76b0',
    glass: t('#cfe2f3'),
    threshold: t('#e7dcc8'),
    door: dark ? '#c9ccd6' : '#5b5f6b',
    swing: dark ? '#999ead' : '#8a8e9a',
    tread: dark ? '#30333b' : t('#f7f6f2'),
    unanchored: dark ? '#191b22' : '#e4e6ec',
    pill: dark ? { fill: '#1e212a', opacity: 0.9, stroke: '#3a3e4a' } : { fill: '#ffffff', opacity: 0.92, stroke: '#d6d9e1' },
    caps: false,
    shadow: pres ? (dark ? { color: '#000000', opacity: 0.7, blur: 3, dy: 2.5 } : { color: '#1a1c22', opacity: 0.4, blur: 2.6, dy: 2 }) : null,
    grid: null,
    weights: { wall: 1, door: 1.25, furniture: 0.75, hatch: 0.5 },
    site: dark ? '#1b2618' : '#d3dfbc',
    // Lawn and planting: the light theme's a touch richer than the quiet legacy palette; the dark theme's own.
    ...(dark
      ? {}
      : { lawn: '#d3dfbc', lawnEdge: '#b4c597', meadow: '#dfe3c2', bed: '#cdb89d', paving: '#d6d1c6', canopy: '#7a9a57', canopyDark: '#4d6e43' }),
  };
}

function lineTheme(style: 'technical' | 'blueprint', theme: ThemeName): PlanTheme {
  const dark = theme === 'dark';
  const blue = style === 'blueprint';
  const paper = blue ? (dark ? '#0d2547' : '#1d4c8a') : dark ? '#101117' : '#ffffff';
  const ink = blue ? (dark ? '#dfe9f8' : '#ffffff') : dark ? '#f0f2f7' : '#101117';
  const muted = blue ? (dark ? '#b8cbe8' : '#dce7f6') : dark ? '#b9bdcb' : '#2c303b';
  const faint = blue ? (dark ? '#8fa8cf' : '#b3c9e8') : dark ? '#999ead' : '#515563';
  const hair = blue ? (dark ? '#5d7cab' : '#87a7d3') : dark ? '#6c7080' : '#8e93a1';
  return {
    ...(dark ? DARK : LIGHT),
    style,
    theme,
    colour: false,
    linework: true,
    paper,
    room: paper,
    floorPlain: paper,
    unanchored: paper,
    poche: ink,
    text: ink,
    muted,
    faint,
    separator: faint,
    hairline: hair,
    window: ink,
    accentInk: '#101117',
    ghost: faint,
    lawn: paper,
    lawnEdge: hair,
    meadow: paper,
    bed: paper,
    edging: hair,
    paving: paper,
    // Planting in hairline over the paper: a technical plan is about the building.
    canopy: hair,
    canopyDark: hair,
    grassInk: hair,
    gardenWall: hair,
    wallExterior: paper,
    wallInterior: ink,
    wallEdge: ink,
    wallHatch: ink,
    glass: paper,
    threshold: paper,
    door: ink,
    swing: muted,
    tread: paper,
    pill: null,
    caps: true,
    shadow: null,
    grid: blue ? { color: '#ffffff', opacity: dark ? 0.07 : 0.11, every: TWO_FT } : null,
    weights: { wall: 1.2, door: 0.9, furniture: 0.45, hatch: 0.35 },
    site: null,
  };
}

/** A style in a theme. */
export function planTheme(style: PlanStyle, theme: ThemeName = 'light'): PlanTheme {
  return style === 'colour' || style === 'presentation' ? colourTheme(style, theme) : lineTheme(style, theme);
}

/** A material's colour as a style draws it: pulled toward the canvas in a dark colour plan, and kept legible under the plan's text. */
export function materialTone(color: string, t: PlanTheme): string {
  return legibleUnder(t.theme === 'dark' ? mix(color, t.paper, DARK_PULL) : color, t.text);
}

/** The text drawn on a pill or straight on the floor: whichever of the plan's text and paper reads better. */
export function inkOn(fill: string, t: PlanTheme): string {
  return contrast(t.text, fill) >= contrast(t.paper, fill) ? t.text : t.paper;
}

// ── floor finishes and their patterns ───────────────────────────────────────

const IN = 32_512;
const MM = 1_280;
const FT = 390_144;

export type FloorPattern =
  | { readonly kind: 'plain' }
  /** Boards along the x axis (before the finish's rotation): their width, length and the gap between them. */
  | { readonly kind: 'plank'; readonly width: number; readonly length: number; readonly gap: number }
  /** Tile or pavers, w × h with a grout joint, laid in a grid or a running bond. */
  | { readonly kind: 'tile'; readonly w: number; readonly h: number; readonly grout: number; readonly bond: 'grid' | 'running' }
  /** Slats in herringbone. */
  | { readonly kind: 'herringbone'; readonly width: number; readonly length: number }
  /** Terrazzo: chips in tiles of this size. */
  | { readonly kind: 'terrazzo'; readonly tile: number }
  | { readonly kind: 'carpet' }
  /** A poured floor's control joints, this far apart. */
  | { readonly kind: 'slab'; readonly joint: number };

/** What a material says of itself that a floor's pattern comes from. */
export interface FinishSource {
  readonly id: string;
  readonly name?: string | undefined;
  readonly color?: string | undefined;
  /** The material library's item (Core 8.1.3's `source.item`). */
  readonly item?: string | undefined;
  /** Its texture's size (Core 18.2), in base units. */
  readonly size?: readonly [number, number] | undefined;
  /** Its texture's rotation, microdegrees counter-clockwise (Core 18.2). */
  readonly rotation?: number | undefined;
}

export interface FloorFinish {
  /** The material's ID: what a pattern is named by. */
  readonly id: string;
  readonly color: string;
  readonly pattern: FloorPattern;
  /** Microdegrees counter-clockwise. */
  readonly rotation: number;
  /** A wet finish — tile, stone — that Technical grids. */
  readonly tiled: boolean;
}

/** The library's floors (FLR-T-13.6) by item: their pattern at their true size, and their maps' size, which a material's own texture size scales. */
const LIBRARY: Readonly<Record<string, { readonly pattern: FloorPattern; readonly map?: number }>> = {
  'white-oak-plank': { pattern: { kind: 'plank', width: 7 * IN, length: 60 * IN, gap: 0 }, map: 2_176_000 },
  'smoked-oak-plank': { pattern: { kind: 'plank', width: 11 * IN, length: 72 * IN, gap: 0 }, map: 2_176_000 },
  'oak-herringbone': { pattern: { kind: 'herringbone', width: 70 * MM, length: 350 * MM }, map: 4_352_000 },
  'cedar-tongue-groove': { pattern: { kind: 'plank', width: 6 * IN, length: 96 * IN, gap: 0 }, map: 1_446_400 },
  'ipe-decking': { pattern: { kind: 'plank', width: 5.5 * IN, length: 96 * IN, gap: IN / 4 }, map: 2_304_000 },
  'composite-decking': { pattern: { kind: 'plank', width: 5.5 * IN, length: 96 * IN, gap: IN / 4 }, map: 2_560_000 },
  'porcelain-warm-stone': { pattern: { kind: 'tile', w: 12 * IN, h: 12 * IN, grout: 3 * MM, bond: 'grid' }, map: 1_920_000 },
  'terrazzo-white': { pattern: { kind: 'terrazzo', tile: 300 * MM }, map: 2_688_000 },
  'terracotta-tile': { pattern: { kind: 'tile', w: 200 * MM, h: 200 * MM, grout: 8 * MM, bond: 'grid' } },
  'marble-carrara': { pattern: { kind: 'tile', w: 24 * IN, h: 24 * IN, grout: 2 * MM, bond: 'grid' } },
  'bluestone-pavers': { pattern: { kind: 'tile', w: 600 * MM, h: 300 * MM, grout: 8 * MM, bond: 'running' } },
  'brick-herringbone-paver': { pattern: { kind: 'herringbone', width: 100 * MM, length: 200 * MM } },
  'concrete-pavers': { pattern: { kind: 'tile', w: 200 * MM, h: 100 * MM, grout: 4 * MM, bond: 'running' } },
  'rectangular-pavers': { pattern: { kind: 'tile', w: 600 * MM, h: 200 * MM, grout: 5 * MM, bond: 'running' } },
  'concrete-smooth': { pattern: { kind: 'slab', joint: 10 * FT } },
  'concrete-broom': { pattern: { kind: 'slab', joint: 10 * FT } },
  'epoxy-floor': { pattern: { kind: 'slab', joint: 10 * FT } },
  'carpet-wool-beige': { pattern: { kind: 'carpet' } },
};

/** A pattern from the words of a material's name, for a material the library did not make. */
function patternOfName(name: string): FloorPattern {
  const n = name.toLowerCase();
  if (/herringbone|parquet|chevron/.test(n)) return { kind: 'herringbone', width: 70 * MM, length: 350 * MM };
  if (/deck/.test(n)) return { kind: 'plank', width: 5.5 * IN, length: 96 * IN, gap: IN / 4 };
  if (/oak|maple|walnut|hickory|pine|cherry|ash|bamboo|wood|plank|hardwood|laminate|lvp|vinyl plank|engineered/.test(n)) return { kind: 'plank', width: 6 * IN, length: 60 * IN, gap: 0 };
  if (/terrazzo/.test(n)) return { kind: 'terrazzo', tile: 300 * MM };
  if (/carpet|rug|wool|sisal|berber/.test(n)) return { kind: 'carpet' };
  if (/paver|brick|cobble|flagstone|bluestone/.test(n)) return { kind: 'tile', w: 600 * MM, h: 300 * MM, grout: 8 * MM, bond: 'running' };
  if (/marble|stone|slate|travertine|limestone|granite/.test(n)) return { kind: 'tile', w: 18 * IN, h: 18 * IN, grout: 3 * MM, bond: 'grid' };
  if (/tile|porcelain|ceramic|mosaic|quarry/.test(n)) return { kind: 'tile', w: 12 * IN, h: 12 * IN, grout: 3 * MM, bond: 'grid' };
  if (/concrete|epoxy|cement|screed|slab/.test(n)) return { kind: 'slab', joint: 10 * FT };
  return { kind: 'plain' };
}

const scaled = (p: FloorPattern, k: number): FloorPattern => {
  if (k === 1 || !(k > 0) || !Number.isFinite(k)) return p;
  switch (p.kind) {
    case 'plank':
      return { ...p, width: p.width * k, length: p.length * k, gap: p.gap * k };
    case 'tile':
      return { ...p, w: p.w * k, h: p.h * k, grout: p.grout * k };
    case 'herringbone':
      return { ...p, width: p.width * k, length: p.length * k };
    case 'terrazzo':
      return { ...p, tile: p.tile * k };
    default:
      return p;
  }
};

/** A material as a floor: its colour, its pattern at true scale and its direction. */
export function floorFinishOf(m: FinishSource): FloorFinish {
  const lib = m.item === undefined ? undefined : LIBRARY[m.item];
  let pattern = lib?.pattern ?? patternOfName(`${m.name ?? ''} ${m.item ?? ''} ${m.id}`);
  // The material's own texture size, against the library's maps: a material laid larger draws larger.
  if (lib?.map !== undefined && m.size !== undefined && m.size[0] > 0) pattern = scaled(pattern, m.size[0] / lib.map);
  const color = typeof m.color === 'string' && /^#[0-9a-f]{6}$/i.test(m.color) ? m.color.toLowerCase() : '#d9d4ca';
  return { id: m.id, color, pattern, rotation: m.rotation ?? 0, tiled: pattern.kind === 'tile' || pattern.kind === 'terrazzo' };
}

/** A material of a document, as a floor finish source. */
export function finishSource(id: string, material: unknown): FinishSource | undefined {
  if (typeof material !== 'object' || material === null) return undefined;
  const m = material as { name?: unknown; color?: unknown; source?: { item?: unknown }; texture?: { size?: unknown; rotation?: unknown } };
  const size = Array.isArray(m.texture?.size) && typeof m.texture.size[0] === 'number' && typeof m.texture.size[1] === 'number' ? ([m.texture.size[0], m.texture.size[1]] as const) : undefined;
  return {
    id,
    ...(typeof m.name === 'string' ? { name: m.name } : {}),
    ...(typeof m.color === 'string' ? { color: m.color } : {}),
    ...(typeof m.source?.item === 'string' ? { item: m.source.item } : {}),
    ...(size === undefined ? {} : { size }),
    ...(typeof m.texture?.rotation === 'number' ? { rotation: m.texture.rotation } : {}),
  };
}

/** The ID a pattern is defined under: a material's, made safe for a URL fragment. */
export const patternId = (prefix: string, id: string): string => `${prefix}-${id.replace(/[^A-Za-z0-9_-]/g, '_')}`;

/** Chips of terrazzo in a unit square: where, how big (of the tile) and which of three tones — written out, so every engine draws the same. */
const CHIPS: readonly (readonly [number, number, number, number])[] = [
  [0.07, 0.12, 0.011, 0], [0.23, 0.31, 0.007, 1], [0.41, 0.08, 0.009, 2], [0.62, 0.21, 0.012, 0], [0.86, 0.09, 0.008, 1],
  [0.13, 0.52, 0.009, 2], [0.34, 0.66, 0.012, 0], [0.55, 0.47, 0.007, 1], [0.77, 0.58, 0.01, 2], [0.94, 0.4, 0.008, 0],
  [0.05, 0.86, 0.008, 1], [0.27, 0.91, 0.01, 2], [0.48, 0.79, 0.008, 0], [0.69, 0.93, 0.011, 1], [0.88, 0.77, 0.009, 2],
  [0.18, 0.04, 0.006, 2], [0.73, 0.37, 0.006, 0], [0.44, 0.33, 0.005, 1], [0.6, 0.7, 0.006, 2], [0.31, 0.45, 0.005, 0],
];

/** Where a pattern sits on the page: pixels per base unit, and where the plan's origin falls. */
export interface PatternFrame {
  readonly k: number;
  readonly origin: XY;
}

const transformOf = (f: PatternFrame, rotation: number): string => {
  const deg = rotation / 1_000_000;
  // Plan y is up and the page's is down: a turn counter-clockwise in plan is clockwise on the page.
  return `translate(${num(f.origin[0])} ${num(f.origin[1])})${deg === 0 ? '' : ` rotate(${num(-deg)})`}`;
};

const line = (x0: number, y0: number, x1: number, y1: number): string => `M${num(x0)} ${num(y0)}L${num(x1)} ${num(y1)}`;
const rect = (x: number, y: number, w: number, h: number, fill: string): string => el('rect', { x, y, width: w, height: h, fill });

/** Plank tones: four rows, each board a shade off its neighbour, so a floor reads as boards and not stripes. */
const BOARD = [0, 0.03, -0.025, 0.015, -0.012, 0.022, -0.03, 0.008, 0.018, -0.018, 0.026, -0.008] as const;

/**
 * A floor finish's `<pattern>` at this drawing's scale, its tile anchored at the plan's origin and
 * turned by the finish's rotation; empty when the pattern is plain or too fine to draw at this
 * scale (the floor is then its colour alone). `fill` is the floor's colour as the style draws it.
 */
export function floorPatternSvg(id: string, finish: FloorFinish, fill: string, f: PatternFrame, theme: PlanTheme): string {
  const p = finish.pattern;
  const k = f.k;
  const dark = theme.theme === 'dark';
  const joint = shade(fill, dark ? -0.32 : -0.2);
  const tf = transformOf(f, finish.rotation);
  const pat = (w: number, h: number, body: string): string => el('pattern', { id, patternUnits: 'userSpaceOnUse', width: w, height: h, patternTransform: tf }, body);
  switch (p.kind) {
    case 'plank': {
      const w = p.width * k;
      const L = p.length * k;
      if (w < 2.5) return '';
      const gap = Math.max(p.gap * k, 0);
      // Six rows, two boards' length wide, each board a shade off its neighbours, joints staggered.
      let body = '';
      let joints = '';
      const R = 6;
      const W = 2 * L;
      for (let i = 0; i < R; i++) {
        const y = i * w;
        const off = ([0, 0.42, 0.78, 0.2, 0.6, 0.9] as const)[i]! * L;
        const tones = [0, 1, 2].map((j) => shade(fill, BOARD[(3 * i + j) % BOARD.length]!));
        body += rect(0, y, off, w, tones[0]!) + rect(off, y, L, w, tones[1]!) + rect(off + L, y, W - off - L, w, tones[2]!);
        joints += line(0, y, W, y) + (off === 0 ? '' : line(off, y, off, y + w)) + line(off + L, y, off + L, y + w);
      }
      joints += line(0, 0, 0, R * w);
      const jw = gap > 0.6 ? gap : Math.min(0.7, Math.max(0.35, w * 0.05));
      return pat(W, R * w, body + el('path', { d: joints, stroke: gap > 0 ? shade(fill, -0.45) : joint, 'stroke-width': jw, 'stroke-opacity': gap > 0 ? 0.9 : 0.5, fill: 'none' }));
    }
    case 'tile': {
      const w = p.w * k;
      const h = p.h * k;
      if (Math.min(w, h) < 3) return '';
      const g = Math.min(Math.max(p.grout * k, 0.5), Math.min(w, h) / 6);
      const grout = dark ? shade(fill, -0.25) : mix(fill, '#8f8a80', 0.32);
      const running = p.bond === 'running';
      const H = running ? 2 * h : h;
      let d = line(0, 0, w, 0) + line(0, 0, 0, h);
      if (running) d += line(0, h, w, h) + line(w / 2, h, w / 2, 2 * h);
      // A pale shade on alternate pavers: laid stone is never one colour.
      const extra = running ? rect(w / 2, h, w / 2, h, shade(fill, 0.02)) + rect(0, 0, w / 2, h, shade(fill, -0.015)) : '';
      return pat(w, H, rect(0, 0, w, H, fill) + extra + el('path', { d, stroke: grout, 'stroke-width': g, 'stroke-opacity': 0.85, fill: 'none' }));
    }
    case 'herringbone': {
      const w = p.width * k;
      const L = p.length * k;
      if (w < 2.5) return '';
      // Chevrons: each arm a slat at 45°, rows a slat's width apart measured square to it.
      const a = L * 0.7071067811865476;
      const h = w * 1.4142135623730951;
      let d = '';
      const n = Math.ceil(a / h) + 1;
      for (let j = -n; j <= 1; j++) {
        const y = j * h;
        d += `M0 ${num(y)}L${num(a)} ${num(y + a)}L${num(2 * a)} ${num(y)}`;
      }
      // Slat ends at the chevrons' points.
      d += line(0, 0, 0, h) + line(a, 0, a, h);
      const body = rect(0, 0, 2 * a, h, fill) + rect(0, 0, a, h, shade(fill, 0.05));
      return pat(2 * a, h, body + el('path', { d, stroke: joint, 'stroke-width': Math.min(0.7, Math.max(0.35, w * 0.08)), 'stroke-opacity': 0.6, fill: 'none' }));
    }
    case 'terrazzo': {
      const T = p.tile * k;
      if (T < 4) return '';
      const tones = [mix(fill, '#000000', dark ? 0.45 : 0.42), mix(fill, '#000000', dark ? 0.28 : 0.24), mix(fill, dark ? '#ffffff' : '#7d8186', dark ? 0.18 : 0.45)];
      let chips = '';
      // Chips 5–15 mm across, shown once they are a pixel.
      if (T * 0.012 >= 0.3)
        for (const [x, y, r, c] of CHIPS) chips += el('circle', { cx: x * T, cy: y * T, r: Math.max(2 * r * T, 0.5), fill: tones[c]! });
      const grout = el('path', { d: line(0, 0, T, 0) + line(0, 0, 0, T), stroke: shade(fill, dark ? -0.22 : -0.12), 'stroke-width': 0.5, 'stroke-opacity': 0.7, fill: 'none' });
      return pat(T, T, rect(0, 0, T, T, fill) + chips + grout);
    }
    case 'carpet': {
      const s = IN * k;
      if (s < 2.5) return '';
      return pat(s, s, rect(0, 0, s, s, fill) + el('circle', { cx: s / 2, cy: s / 2, r: Math.min(0.5, s / 6), fill: shade(fill, -0.12), 'fill-opacity': 0.6 }));
    }
    case 'slab': {
      const s = p.joint * k;
      if (s < 6) return '';
      return pat(s, s, rect(0, 0, s, s, fill) + el('path', { d: line(0, 0, s, 0) + line(0, 0, 0, s), stroke: shade(fill, dark ? -0.3 : -0.18), 'stroke-width': 0.75, 'stroke-opacity': 0.8, fill: 'none' }));
    }
    default:
      return '';
  }
}

/** Technical's grid over a wet room: tile lines in the hairline ink, nothing else. Empty when too fine. */
export function gridPatternSvg(id: string, size: readonly [number, number], f: PatternFrame, theme: PlanTheme, rotation = 0): string {
  const w = size[0] * f.k;
  const h = size[1] * f.k;
  if (Math.min(w, h) < 4) return '';
  return el(
    'pattern',
    { id, patternUnits: 'userSpaceOnUse', width: w, height: h, patternTransform: transformOf(f, rotation) },
    el('path', { d: line(0, 0, w, 0) + line(0, 0, 0, h), stroke: theme.hairline, 'stroke-width': theme.weights.hatch, fill: 'none' }),
  );
}

/** A 45° hatch, in screen space: Technical's exterior walls and patios. */
export function hatchPatternSvg(id: string, spacing: number, ink: string, width: number): string {
  const s = spacing;
  return el('pattern', { id, patternUnits: 'userSpaceOnUse', width: s, height: s }, el('path', { d: `M${num(-s / 4)} ${num(s / 4)}L${num(s / 4)} ${num(-s / 4)}M0 ${num(s)}L${num(s)} 0M${num((3 * s) / 4)} ${num((5 * s) / 4)}L${num((5 * s) / 4)} ${num((3 * s) / 4)}`, stroke: ink, 'stroke-width': width }));
}

/** Presentation's soft drop shadow. */
export function shadowFilterSvg(id: string, t: PlanTheme): string {
  const sh = t.shadow;
  if (sh === null) return '';
  return el(
    'filter',
    { id, x: '-5%', y: '-5%', width: '110%', height: '115%', 'color-interpolation-filters': 'sRGB' },
    el('feDropShadow', { dx: 0, dy: sh.dy, stdDeviation: sh.blur, 'flood-color': sh.color, 'flood-opacity': sh.opacity }),
  );
}

// ── walls by type ────────────────────────────────────────────────────────────

export type WallClass = 'exterior' | 'interior';

/** A wall type's class from its layers and name (Core 8.2): a membrane, an air gap or sheathing, or "exterior", is an outside wall. */
export function wallClassOf(type: unknown): WallClass | undefined {
  if (typeof type !== 'object' || type === null) return undefined;
  const t = type as { name?: unknown; layers?: unknown };
  const layers = Array.isArray(t.layers) ? (t.layers as { function?: unknown }[]) : [];
  if (layers.some((l) => l.function === 'membrane' || l.function === 'airGap' || l.function === 'substrate')) return 'exterior';
  if (typeof t.name === 'string') {
    if (/exterior|outside|external/i.test(t.name)) return 'exterior';
    if (/interior|partition|internal/i.test(t.name)) return 'interior';
  }
  return layers.length > 0 ? 'interior' : undefined;
}

/**
 * A wall type's colour in Construction mode's legend (FLR-T-18.3, 18.5): an exterior type in the
 * colour of its outside finish (its first layer with a material), lifted on a dark canvas; an
 * interior type in the wall poché.
 */
export function wallTypeColour(type: unknown, materials: Readonly<Record<string, unknown>> | undefined, cls: WallClass, t: PlanTheme): string {
  if (cls === 'interior') return t.linework ? t.poche : t.wallInterior;
  const layers = typeof type === 'object' && type !== null && Array.isArray((type as { layers?: unknown }).layers) ? ((type as { layers: { material?: unknown }[] }).layers) : [];
  const first = layers.find((l) => typeof l.material === 'string');
  const m = first === undefined || materials === undefined ? undefined : materials[first.material as string];
  const c = typeof m === 'object' && m !== null && typeof (m as { color?: unknown }).color === 'string' ? (m as { color: string }).color : undefined;
  if (c === undefined || !/^#[0-9a-f]{6}$/i.test(c)) return t.theme === 'dark' ? '#9fb0bd' : '#5f7486';
  // On the dark canvas a dark finish lifts; on the light one a pale finish darkens, so a wall never vanishes.
  const tone = c.toLowerCase();
  if (t.theme === 'dark') return luminance(tone) < 0.18 ? shade(tone, 0.22) : tone;
  return luminance(tone) > 0.45 ? shade(tone, -0.25) : tone;
}

/** The construction amber door leaves and swings are drawn in, in Construction mode. */
export const CONSTRUCTION_DOOR = { light: '#b07400', dark: '#f2b84b' } as const;

// ── furniture in colour ──────────────────────────────────────────────────────

/** An item's colour and the darker ink its lines are drawn in, by what it is; null for what a colour plan draws in its ink. */
export function furnitureTone(category: string | undefined, collection: string, catalogue: string | undefined, t: PlanTheme): { fill: string; ink: string } | null {
  const c = category ?? '';
  const k = (catalogue ?? '').toLowerCase();
  let base: string | null = null;
  if (collection === 'casework') base = c === 'island' ? '#e7e4de' : '#f1efea';
  else if (collection === 'appliances') base = '#d7dadf';
  else if (collection === 'fixtures' || collection === 'heaters' || collection === 'receptors') base = '#fafaf8';
  else
    switch (c) {
      case 'bed':
        base = '#f5f4f0';
        break;
      case 'sofa':
      case 'armchair':
      case 'sectional':
      case 'ottoman':
        base = '#8f9bb2';
        break;
      case 'chair':
      case 'stool':
      case 'bench':
        base = '#b48f66';
        break;
      case 'diningTable':
      case 'coffeeTable':
      case 'sideTable':
      case 'table':
      case 'desk':
        base = '#8a6446';
        break;
      case 'dresser':
      case 'nightstand':
      case 'bookcase':
      case 'cabinet':
      case 'tvStand':
      case 'wardrobe':
        base = '#9b7654';
        break;
      default:
        if (/^rug|runner|bath-mat|mat-/.test(k)) base = '#dcd2c0';
        else if (isPlant(catalogue)) base = '#7a9a57';
    }
  if (base === null) return null;
  const fill = materialTone(base, t);
  return { fill, ink: shade(fill, t.theme === 'dark' ? -0.42 : -0.38) };
}

/** A plant in a planter: drawn round, as its leaves are from above. */
export const isPlant = (catalogue: string | undefined): boolean => /plant|tree/.test((catalogue ?? '').toLowerCase());

/** Rugs lie under everything else in a room. */
export const isRug = (catalogue: string | undefined): boolean => /^rug|runner|bath-mat/.test((catalogue ?? '').toLowerCase());

/** The accent, for highlighted elements, is the same in every style. */
export const STYLE_ACCENT = ACCENT;
