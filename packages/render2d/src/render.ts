/**
 * The plan renderer (FLR-T-2.8): one level of a Floorspec document as a standalone SVG.
 *
 * Deterministic: the same document and options give the same bytes — elements are drawn in ID
 * order, every number goes through one fixed formatter, and nothing reads a clock or a random
 * source. Only `Math.sqrt` (correctly rounded in every engine) is used on floats, and only to place
 * symbols relative to points the engine derived; there is no trigonometry.
 */
import { BU_PER_FOOT, feetInches, num, squareFeet } from './format.js';
import { diffScenes, type Change, type SceneDiff } from './ghost.js';
import { buildScene, type Pt, type Scene, type SceneOpening, type SceneRoom, type SceneWall } from './scene.js';
import { el, escText as esc, linePath, ringsPath, type XY } from './svg.js';
import { roofSymbol, stairSymbol } from './symbols.js';
import { PALETTES, type Palette, type ThemeName } from './theme.js';

export interface RenderOptions {
  /** The level to draw. Default: the lowest by elevation, then by ID. */
  readonly level?: string;
  /** Core 0.3 (19.6): the design of a document with design options to draw — option set → option. Default: the primary design. */
  readonly design?: Readonly<Record<string, string>>;
  /** Default `light`. */
  readonly theme?: ThemeName;
  /** Drawing scale in SVG pixels per foot. Default 24. */
  readonly scale?: number;
  /** Element IDs to draw in the accent (walls, junctions, separators, openings, rooms). */
  readonly highlight?: readonly string[];
  /** Changeset ghosting: the document before the changeset; this document is the after side. */
  readonly ghost?: { readonly before: string | Uint8Array | object };
  /** Overall exterior dimensions. Default true. */
  readonly dimensions?: boolean;
  /** Room labels (name, area, dimensions, ID). Default true. */
  readonly labels?: boolean;
  /** Clearance envelopes (Core 0.2, 13.5) as dashed boxes. Default false. */
  readonly clearances?: boolean;
  /**
   * The roof layer (Core 0.3, 16): each roof on the level — its eave outline dashed, its ridges,
   * hips and valleys, and the eave edge of each gable end. Default false.
   */
  readonly roof?: boolean;
}

export const DEFAULT_SCALE = 24;

const SANS = 'Inter, sans-serif';
const MONO = "'JetBrains Mono', monospace";

/** The line weight of the wall outline, in pixels. */
const OUTLINE = 1;

const FUNCTION_LABELS: Readonly<Record<string, string>> = {
  unspecified: 'Room',
  sleeping: 'Bedroom',
  bath: 'Bath',
  kitchen: 'Kitchen',
  living: 'Living',
  dining: 'Dining',
  office: 'Office',
  laundry: 'Laundry',
  utility: 'Utility',
  storage: 'Storage',
  circulation: 'Hall',
  mechanical: 'Mechanical',
  garage: 'Garage',
  exterior: 'Exterior',
};

/** What a room's label says when it has no name: its function (Core 4.1), else the extension term. */
function roomTitle(r: SceneRoom): string {
  if (r.name !== undefined && r.name.trim() !== '') return r.name;
  return FUNCTION_LABELS[r.function] ?? r.function;
}

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function grow(box: Box | undefined, pts: readonly Pt[]): Box | undefined {
  let b = box;
  for (const [x, y] of pts) {
    if (!b) b = { minX: x, minY: y, maxX: x, maxY: y };
    else {
      if (x < b.minX) b.minX = x;
      if (y < b.minY) b.minY = y;
      if (x > b.maxX) b.maxX = x;
      if (y > b.maxY) b.maxY = y;
    }
  }
  return b;
}

// ── label placement ──────────────────────────────────────────────────────────

function insideRings(x: number, y: number, rings: readonly (readonly Pt[])[]): boolean {
  let inside = false;
  for (const r of rings)
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i]!;
      const [xj, yj] = r[j]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  return inside;
}

function segDist(x: number, y: number, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((x - a[0]) * dx + (y - a[1]) * dy) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = a[0] + t * dx - x;
  const py = a[1] + t * dy - y;
  return Math.sqrt(px * px + py * py);
}

function clearance(x: number, y: number, rings: readonly (readonly Pt[])[], obstacles: readonly (readonly Pt[])[]): number {
  if (!insideRings(x, y, rings)) return -1;
  for (const o of obstacles) if (insideRings(x, y, [o])) return -1;
  let d = Infinity;
  for (const r of [...rings, ...obstacles]) for (let i = 0, j = r.length - 1; i < r.length; j = i++) d = Math.min(d, segDist(x, y, r[j]!, r[i]!));
  return d;
}

/**
 * A point well inside a polygon with holes, clear of obstacles (door swings), for its label: the
 * bounding box's centre when it is nearly as clear as the clearest point a two-pass grid search
 * finds, else that point.
 */
export function labelPoint(
  outer: readonly Pt[],
  holes: readonly (readonly Pt[])[],
  obstacles: readonly (readonly Pt[])[] = [],
): { x: number; y: number; clear: number } {
  const rings = [outer, ...holes];
  const b = grow(undefined, outer)!;
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  let best = { x: cx, y: cy, clear: clearance(cx, cy, rings, obstacles) };
  const search = (x0: number, y0: number, w: number, h: number, n: number): void => {
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const x = x0 + ((i + 0.5) * w) / n;
        const y = y0 + ((j + 0.5) * h) / n;
        const c = clearance(x, y, rings, obstacles);
        if (c > best.clear) best = { x, y, clear: c };
      }
  };
  const center = best;
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  search(b.minX, b.minY, w, h, 24);
  search(best.x - w / 24, best.y - h / 24, w / 12, h / 12, 12);
  return center.clear >= 0.85 * best.clear ? center : best;
}

/** How far a point can reach left, right, down and up before it meets an edge. */
function freeSpan(x: number, y: number, polys: readonly (readonly Pt[])[]): { h: number; v: number } {
  let left = Infinity;
  let right = Infinity;
  let down = Infinity;
  let up = Infinity;
  for (const r of polys)
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [ax, ay] = r[j]!;
      const [bx, by] = r[i]!;
      if (ay > y !== by > y) {
        const xi = ax + ((y - ay) * (bx - ax)) / (by - ay);
        if (xi <= x) left = Math.min(left, x - xi);
        else right = Math.min(right, xi - x);
      }
      if (ax > x !== bx > x) {
        const yi = ay + ((x - ax) * (by - ay)) / (bx - ax);
        if (yi <= y) down = Math.min(down, y - yi);
        else up = Math.min(up, yi - y);
      }
    }
  return { h: 2 * Math.min(left, right), v: 2 * Math.min(down, up) };
}

// ── the renderer ─────────────────────────────────────────────────────────────

interface Frame {
  readonly s: number;
  readonly X: (x: number) => number;
  readonly Y: (y: number) => number;
  readonly P: (p: Pt) => XY;
}

/** Unit vector along a wall and its left normal, in base-unit space. */
function axes(a: Pt, b: Pt): { u: XY; n: XY; len: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.sqrt(dx * dx + dy * dy);
  return { u: [dx / len, dy / len], n: [-dy / len, dx / len], len };
}

const add = (p: Pt, v: XY, k: number): Pt => [p[0] + v[0] * k, p[1] + v[1] * k];

/** The quadrilateral an opening cuts from its wall, its faces pushed out by `extra` base units. */
function openingQuad(o: SceneOpening, w: SceneWall, extra: number): Pt[] {
  const { n } = axes(w.start, w.end);
  return [add(o.start, n, w.a + extra), add(o.end, n, w.a + extra), add(o.end, n, -(w.b + extra)), add(o.start, n, -(w.b + extra))];
}

interface SymbolStyle {
  readonly stroke: string;
  readonly window: string;
  readonly dash?: string;
  readonly opacity?: number;
}

/** A door leaf and its swing, a window's glazing, or nothing for an empty opening (Core 7.1). */
function openingSymbol(o: SceneOpening, w: SceneWall, f: Frame, st: SymbolStyle): string {
  const { n, len } = axes(o.start, o.end);
  if (len === 0) return '';
  const common = { fill: 'none', 'stroke-dasharray': st.dash, opacity: st.opacity };
  if (o.kind === 'door') {
    const left = o.swing === 'left';
    const off = left ? w.a : -w.b;
    const dir: XY = left ? n : [-n[0], -n[1]];
    const J = o.hinge === 'start' ? o.start : o.end;
    const K = o.hinge === 'start' ? o.end : o.start;
    const H = add(J, n, off);
    const L = add(H, dir, len);
    const O = add(K, n, off);
    const [hx, hy] = f.P(H);
    const [lx, ly] = f.P(L);
    const [ox, oy] = f.P(O);
    // Positive cross product in screen space (y down) is a clockwise turn: SVG's sweep-flag 1.
    const sweep = (lx - hx) * (oy - hy) - (ly - hy) * (ox - hx) > 0 ? 1 : 0;
    const r = len * f.s;
    return (
      el('path', { d: linePath([hx, hy], [lx, ly]), stroke: st.stroke, 'stroke-width': 1.5, 'stroke-linecap': 'round', ...common }) +
      el('path', {
        d: `M${num(lx)} ${num(ly)}A${num(r)} ${num(r)} 0 0 ${sweep} ${num(ox)} ${num(oy)}`,
        stroke: st.stroke,
        'stroke-width': 1,
        ...common,
        'stroke-dasharray': st.dash ?? '3 2',
      })
    );
  }
  if (o.kind === 'window') {
    const T = w.a + w.b;
    const mid = (w.a - w.b) / 2;
    const g = T / 7;
    const lines = [w.a, -w.b, mid + g, mid - g].map((k) => linePath(f.P(add(o.start, n, k)), f.P(add(o.end, n, k)))).join('');
    return el('path', { d: lines, stroke: st.window, 'stroke-width': 1, ...common });
  }
  return '';
}

/** The corners of the square a door leaf sweeps; an opening's quad otherwise. */
function symbolReach(o: SceneOpening, w: SceneWall): Pt[] {
  const { n, len } = axes(o.start, o.end);
  if (o.kind !== 'door' || len === 0) return openingQuad(o, w, 0);
  const left = o.swing === 'left';
  const off = left ? w.a : -w.b;
  const k = off + (left ? len : -len);
  return [add(o.start, n, off), add(o.end, n, off), add(o.end, n, k), add(o.start, n, k)];
}

function jambs(o: SceneOpening, w: SceneWall, f: Frame, color: string): string {
  const { n } = axes(w.start, w.end);
  const out = OUTLINE / f.s;
  const d = [o.start, o.end].map((p) => linePath(f.P(add(p, n, w.a + out)), f.P(add(p, n, -(w.b + out))))).join('');
  return el('path', { d, stroke: color, 'stroke-width': 2 * OUTLINE, fill: 'none' });
}

interface LabelLine {
  readonly text: string;
  readonly size: number;
  readonly mono: boolean;
  readonly weight?: number;
  readonly color: string;
  readonly spacing?: number;
  /** A pill behind the line, in this colour: the ID of a changed room. */
  readonly pill?: string;
}

/** An estimate of a line's width in pixels — enough to decide whether a label fits. */
const lineWidth = (l: LabelLine): number => l.text.length * l.size * (l.mono ? 0.6 : 0.56) + (l.spacing ?? 0) * l.text.length;

function labelBlock(lines: readonly LabelLine[], x: number, y: number, rotate: boolean, attrs: Record<string, string> = {}): string {
  const gap = 3;
  const heights = lines.map((l) => l.size * 1.15);
  const total = heights.reduce((s, h) => s + h, 0) + gap * (lines.length - 1);
  let cursor = -total / 2;
  let body = '';
  lines.forEach((l, i) => {
    const h = heights[i]!;
    cursor += h;
    if (l.pill) {
      const w = lineWidth(l) + 8;
      body += el('rect', { x: -w / 2, y: cursor - h - 1, width: w, height: h + 3, rx: 3, fill: l.pill });
    }
    body += el(
      'text',
      {
        y: cursor - l.size * 0.22,
        'font-family': l.mono ? MONO : undefined,
        'font-size': l.size,
        'font-weight': l.weight,
        'letter-spacing': l.spacing,
        fill: l.color,
      },
      esc(l.text),
    );
    cursor += gap;
  });
  return el('g', { ...attrs, transform: `translate(${num(x)} ${num(y)})${rotate ? ' rotate(-90)' : ''}`, 'text-anchor': 'middle' }, body);
}

/** Render one level of a Floorspec document as a standalone SVG string. */
export function renderPlan(document: string | Uint8Array | object, options: RenderOptions = {}): string {
  const scene = buildScene(document, options.level, options.design);
  const pal = PALETTES[options.theme ?? 'light'];
  const scale = options.scale ?? DEFAULT_SCALE;
  if (!(scale > 0) || !Number.isFinite(scale)) throw new RangeError('scale must be a positive number of pixels per foot');
  const showDims = options.dimensions ?? true;
  const showLabels = options.labels ?? true;

  let before: Scene | undefined;
  let diff: SceneDiff | undefined;
  if (options.ghost) {
    const doc = options.ghost.before;
    // The before side may not have this level at all: then everything on it is new.
    try {
      before = buildScene(doc, scene.levelId);
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      before = undefined;
    }
    diff = diffScenes(before, scene);
  }
  const hi = new Set(options.highlight ?? []);
  const accented = (id: string, d: { readonly changes: ReadonlyMap<string, Change> } | undefined): boolean => {
    const c = d?.changes.get(id);
    return hi.has(id) || c === 'added' || c === 'moved';
  };

  // ── extent ──
  let body: Box | undefined;
  for (const w of scene.walls.values()) body = grow(body, w.outline);
  for (const r of scene.fills.values()) body = grow(body, r);
  let all = body && { ...body };
  for (const r of scene.rooms.values()) all = grow(all, r.outer);
  for (const s of scene.separators.values()) all = grow(all, [s.start, s.end]);
  for (const u of scene.unanchored) all = grow(all, u.outer);
  for (const sl of scene.slabs.values()) all = grow(all, sl.outline);
  for (const st of scene.stairs.values()) all = grow(all, [[st.derived.box.min[0], st.derived.box.min[1]], [st.derived.box.max[0], st.derived.box.max[1]]]);
  const showRoof = options.roof ?? false;
  if (showRoof) for (const rf of scene.roofs.values()) all = grow(all, rf.outline);
  for (const fb of scene.fallbacks.values()) all = grow(all, fb.footprint);
  const showClearances = options.clearances ?? false;
  if (showClearances) for (const c of scene.clearances) all = grow(all, c.footprint);
  if (diff) {
    for (const w of diff.walls.before.values()) all = grow(all, w.outline);
    for (const r of diff.rooms.before.values()) all = grow(all, r.outer);
    for (const s of diff.separators.before.values()) all = grow(all, [s.start, s.end]);
  }
  // Door leaves swing out of the building: their reach is part of the drawing.
  for (const o of [...scene.openings.values(), ...(diff ? diff.openings.before.values() : [])]) {
    const w = scene.walls.get(o.wall) ?? diff?.walls.before.get(o.wall);
    if (w) all = grow(all, symbolReach(o, w));
  }
  const ext: Box = all ?? { minX: 0, minY: 0, maxX: BU_PER_FOOT * 10, maxY: BU_PER_FOOT * 10 };

  const s = scale / BU_PER_FOOT;
  const margin = { top: showDims ? 64 : 32, left: showDims ? 64 : 32, right: 32, bottom: 64 };
  const W = Math.ceil((ext.maxX - ext.minX) * s + margin.left + margin.right);
  const H = Math.ceil((ext.maxY - ext.minY) * s + margin.top + margin.bottom);
  const X = (x: number): number => margin.left + (x - ext.minX) * s;
  const Y = (y: number): number => margin.top + (ext.maxY - y) * s;
  const f: Frame = { s, X, Y, P: (p) => [X(p[0]), Y(p[1])] };
  const P = (ring: readonly Pt[]): XY[] => ring.map(f.P);

  const title = `${scene.levelName ?? scene.levelId}${scene.projectName ? ` · ${scene.projectName}` : ''}`;
  const parts: string[] = [];
  parts.push(el('title', {}, esc(title)));
  parts.push(el('rect', { width: W, height: H, fill: pal.paper }));

  // ── defs: the opening cuts, and the hatch for unanchored faces ──
  const cut = OUTLINE / s + 0.75 / s;
  const cuts = [...scene.openings.values()].map((o) => el('path', { d: ringsPath([P(openingQuad(o, scene.walls.get(o.wall)!, cut))]), fill: '#000' })).join('');
  parts.push(
    el(
      'defs',
      {},
      el('mask', { id: 'fs-cuts', maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: W, height: H }, el('rect', { width: W, height: H, fill: '#fff' }) + cuts) +
        el(
          'pattern',
          { id: 'fs-hatch', patternUnits: 'userSpaceOnUse', width: 8, height: 8 },
          el('path', { d: 'M-2 2L2 -2M0 8L8 0M6 10L10 6', stroke: pal.hairline, 'stroke-width': 1 }),
        ),
    ),
  );

  // ── slabs (Core 6.7): authored floors outside the rooms, drawn first and hatched ──
  if (scene.slabs.size) {
    let slabs = '';
    for (const sl of scene.slabs.values()) {
      const d = ringsPath([P(sl.outline)]);
      const a = hi.has(sl.id);
      slabs +=
        el('path', { 'data-id': sl.id, ...(sl.purpose === undefined ? {} : { 'data-purpose': sl.purpose }), d, fill: a ? pal.accent : pal.unanchored, 'fill-opacity': a ? 0.35 : 1, stroke: pal.faint, 'stroke-width': 1 }) +
        el('path', { d, fill: 'url(#fs-hatch)' });
    }
    parts.push(el('g', { id: 'slabs' }, slabs));
  }

  // ── floors ──
  let floors = '';
  for (const r of scene.rooms.values()) {
    floors += el('path', { 'data-id': r.id, d: ringsPath([P(r.outer), ...r.holes.map(P)]), fill: pal.room, 'fill-rule': 'evenodd' });
    // Added and highlighted rooms are tinted; a room that only moved shows its old outline instead.
    if (hi.has(r.id) || diff?.rooms.changes.get(r.id) === 'added')
      floors += el('path', { d: ringsPath([P(r.outer), ...r.holes.map(P)]), fill: pal.accent, 'fill-opacity': 0.16, 'fill-rule': 'evenodd' });
  }
  // The floor runs through every opening: a door or window is cut through the wall to the floor.
  for (const o of scene.openings.values())
    floors += el('path', { d: ringsPath([P(openingQuad(o, scene.walls.get(o.wall)!, 0))]), fill: pal.room });
  for (const u of scene.unanchored) {
    const d = ringsPath([P(u.outer), ...u.holes.map(P)]);
    floors += el('path', { d, fill: pal.unanchored, 'fill-rule': 'evenodd' }) + el('path', { d, fill: 'url(#fs-hatch)', 'fill-rule': 'evenodd' });
  }
  parts.push(el('g', { id: 'floors' }, floors));

  // ── ceilings that are not flat (Core 0.3, 15.3, 15.4): a tray's centre dashed, a vault's ridge dash-dotted ──
  let ceilings = '';
  for (const r of scene.rooms.values()) {
    const c = r.ceiling;
    if (c?.kind === 'tray' && c.tray !== undefined)
      ceilings += el('path', { 'data-id': `${r.id}:tray`, d: ringsPath(c.tray.map(P)), fill: 'none', stroke: pal.faint, 'stroke-width': 1, 'stroke-dasharray': '2 3', 'fill-rule': 'evenodd' });
    if (c?.kind === 'vaulted' && c.ridge !== undefined)
      ceilings += el('path', { 'data-id': `${r.id}:ridge`, d: linePath(f.P(c.ridge[0]), f.P(c.ridge[1])), stroke: pal.faint, 'stroke-width': 1.25, 'stroke-dasharray': '8 3 2 3', fill: 'none' });
  }
  if (ceilings !== '') parts.push(el('g', { id: 'ceilings' }, ceilings));

  // ── stairs (Core 0.3, 17): treads, landings, the cut line and the UP arrow ──
  if (scene.stairs.size) {
    let stairs = '';
    for (const [id, st] of scene.stairs) {
      const sym = stairSymbol(st.derived, st.form);
      const a = hi.has(id);
      const ink = a ? pal.accent : pal.muted;
      let g = '';
      for (const step of sym.steps)
        g += el('path', {
          'data-step': step.landing ? 'landing' : 'tread',
          d: ringsPath([P(step.outline)]),
          fill: step.landing ? pal.unanchored : 'none',
          stroke: ink,
          'stroke-width': 1,
          ...(step.above ? { 'stroke-dasharray': '3 3' } : {}),
        });
      if (sym.bounds) g += el('path', { d: ringsPath([P(sym.bounds)]), fill: 'none', stroke: ink, 'stroke-width': 1, 'stroke-dasharray': '6 3' });
      if (sym.circle) {
        const c = f.P(sym.circle.centre);
        g += el('circle', { cx: c[0], cy: c[1], r: sym.circle.radius * s, fill: 'none', stroke: ink, 'stroke-width': 1 });
      }
      if (sym.cut) g += el('path', { 'data-cut': id, d: linePath(f.P(sym.cut[0]), f.P(sym.cut[1])), stroke: pal.text, 'stroke-width': 1.5, fill: 'none' });
      g += arrow(sym.arrow.map(f.P), ink);
      const up = f.P(sym.up);
      g += el('text', { x: up[0], y: up[1] + 12, 'text-anchor': 'middle', 'font-size': 9, 'font-weight': 600, fill: ink }, 'UP');
      stairs += el('g', { 'data-id': id, 'data-form': st.form }, g);
    }
    parts.push(el('g', { id: 'stairs' }, stairs));
  }

  // ── separators ──
  let seps = '';
  for (const sp of scene.separators.values()) {
    const acc = accented(sp.id, diff?.separators);
    seps += el('path', {
      'data-id': sp.id,
      d: linePath(f.P(sp.start), f.P(sp.end)),
      stroke: acc ? pal.accent : pal.separator,
      'stroke-width': acc ? 2 : 1.25,
      'stroke-dasharray': '6 4',
      fill: 'none',
    });
  }
  parts.push(el('g', { id: 'separators' }, seps));

  // ── walls: one solid poché — an outline layer under a fill layer, so pieces join without seams ──
  const bodies: { id: string; ring: readonly Pt[]; acc: boolean }[] = [
    ...[...scene.walls.values()].map((w) => ({ id: w.id, ring: w.outline, acc: accented(w.id, diff?.walls) })),
    ...[...scene.fills].map(([id, ring]) => ({ id, ring, acc: accented(id, diff?.fills) })),
  ];
  const outlineLayer = el(
    'path',
    { d: ringsPath(bodies.map((b) => P(b.ring))), fill: pal.poche, stroke: pal.poche, 'stroke-width': 2 * OUTLINE, 'stroke-linejoin': 'round' },
  );
  const plain = bodies.filter((b) => !b.acc);
  const acc = bodies.filter((b) => b.acc);
  let fillLayer = el('path', { d: ringsPath(plain.map((b) => P(b.ring))), fill: pal.poche, stroke: pal.poche, 'stroke-width': 0.5, 'stroke-linejoin': 'round' });
  for (const b of acc)
    fillLayer += el('path', { 'data-id': b.id, d: ringsPath([P(b.ring)]), fill: pal.accent, stroke: pal.accent, 'stroke-width': 0.5, 'stroke-linejoin': 'round' });
  parts.push(el('g', { id: 'walls', mask: 'url(#fs-cuts)' }, outlineLayer + fillLayer));

  // ── openings ──
  let ops = '';
  for (const o of scene.openings.values()) {
    const w = scene.walls.get(o.wall)!;
    const a = accented(o.id, diff?.openings);
    ops += el(
      'g',
      { 'data-id': o.id },
      jambs(o, w, f, accented(o.wall, diff?.walls) ? pal.accent : pal.poche) +
        openingSymbol(o, w, f, a ? { stroke: pal.accent, window: pal.accent } : { stroke: pal.faint, window: pal.window }),
    );
  }
  parts.push(el('g', { id: 'openings' }, ops));

  // ── extension elements: their fallback boxes (Core 0.2, 12.6), drawn by a core-only reader ──
  if (scene.fallbacks.size) {
    let fbs = '';
    for (const fb of scene.fallbacks.values()) {
      const a = hi.has(fb.id);
      fbs += el('path', {
        'data-id': fb.id,
        'data-kind': `${fb.extension}:${fb.collection}`,
        d: ringsPath([P(fb.footprint)]),
        fill: a ? pal.accent : pal.faint,
        'fill-opacity': a ? 0.35 : 0.12,
        stroke: a ? pal.accent : pal.faint,
        'stroke-width': 1,
      });
    }
    parts.push(el('g', { id: 'fallbacks' }, fbs));
  }

  // ── clearance envelopes (Core 0.2, 13.5), when asked for ──
  if (showClearances && scene.clearances.length) {
    let cls = '';
    for (const c of scene.clearances)
      cls += el('path', {
        'data-owner': c.owner,
        'data-name': c.name,
        'data-purpose': c.purpose,
        d: ringsPath([P(c.footprint)]),
        fill: pal.window,
        'fill-opacity': 0.06,
        stroke: pal.window,
        'stroke-width': 1,
        'stroke-dasharray': '4 3',
      });
    parts.push(el('g', { id: 'clearances' }, cls));
  }

  // ── the roof layer (Core 0.3, 16): eave outline dashed, ridges, hips and valleys, gable ends ──
  if (showRoof && scene.roofs.size) {
    let roofs = '';
    for (const [id, rf] of scene.roofs) {
      const sym = roofSymbol(rf);
      const ink = hi.has(id) ? pal.accent : pal.text;
      let g = el('path', { 'data-eave': id, d: ringsPath([P(sym.eave)]), fill: 'none', stroke: ink, 'stroke-width': 1.25, 'stroke-dasharray': '7 4' });
      for (const l of sym.lines)
        g += el('path', { 'data-line': l.kind, d: linePath(f.P(l.from), f.P(l.to)), stroke: ink, 'stroke-width': l.kind === 'ridge' ? 1.5 : 1, ...(l.kind === 'valley' ? { 'stroke-dasharray': '2 2' } : {}), fill: 'none' });
      for (const [a, b] of sym.gables) g += el('path', { 'data-gable': id, d: linePath(f.P(a), f.P(b)), stroke: ink, 'stroke-width': 2.5, fill: 'none' });
      roofs += el('g', { 'data-id': id, 'data-kind': rf.kind }, g);
    }
    parts.push(el('g', { id: 'roofs' }, roofs));
  }

  // ── ghosts: what the changeset removed, and where moved elements were ──
  if (diff) {
    let g = '';
    const ghostStroke = { stroke: pal.ghost, 'stroke-width': 1.25, 'stroke-dasharray': '5 3', fill: 'none' };
    // A room's old rings that its new polygon no longer has: where its boundary was.
    const key = (ring: readonly Pt[]): string => ring.map((p) => `${p[0]},${p[1]}`).join(' ');
    for (const [id, r] of diff.rooms.before) {
      const now = scene.rooms.get(id);
      const kept = new Set(now ? [now.outer, ...now.holes].map(key) : []);
      const gone = [r.outer, ...r.holes].filter((ring) => !kept.has(key(ring)));
      if (gone.length) g += el('path', { 'data-ghost': id, d: ringsPath(gone.map(P)), ...ghostStroke, opacity: 0.7 });
    }
    for (const [id, sp] of diff.separators.before)
      g += el('path', { 'data-ghost': id, d: linePath(f.P(sp.start), f.P(sp.end)), ...ghostStroke, opacity: 0.7 });
    const wallGhosts = [...diff.walls.before].map(([id, w]) => ({ id, ring: w.outline, removed: diff.walls.changes.get(id) === 'removed' }));
    const fillGhosts = [...diff.fills.before].map(([id, ring]) => ({ id, ring, removed: diff.fills.changes.get(id) === 'removed' }));
    for (const b of [...wallGhosts, ...fillGhosts])
      g += el('path', {
        'data-ghost': b.id,
        d: ringsPath([P(b.ring)]),
        ...ghostStroke,
        fill: b.removed ? pal.ghost : 'none',
        'fill-opacity': b.removed ? 0.22 : undefined,
      });
    for (const [id, o] of diff.openings.before) {
      const w = scene.walls.get(o.wall) ?? diff.walls.before.get(o.wall) ?? before?.walls.get(o.wall);
      if (!w) continue;
      g += el(
        'g',
        { 'data-ghost': id },
        el('path', { d: ringsPath([P(openingQuad(o, w, 0))]), ...ghostStroke, opacity: 0.8 }) +
          openingSymbol(o, w, f, { stroke: pal.ghost, window: pal.ghost, dash: '3 3', opacity: 0.8 }),
      );
    }
    parts.push(el('g', { id: 'ghosts' }, g));
  }

  // ── labels ──
  if (showLabels) {
    let labels = '';
    // Labels keep clear of the squares door leaves sweep.
    const swings = [...scene.openings.values()].filter((o) => o.kind === 'door').map((o) => symbolReach(o, scene.walls.get(o.wall)!));
    for (const r of scene.rooms.values()) {
      const rb = grow(undefined, r.outer)!;
      const lines: LabelLine[] = [
        { text: roomTitle(r), size: 13, mono: false, weight: 500, color: pal.text },
        { text: `${squareFeet(r.area)} ft²`, size: 11, mono: true, color: pal.muted },
        { text: `${feetInches(rb.maxX - rb.minX)} × ${feetInches(rb.maxY - rb.minY)}`, size: 10, mono: true, color: pal.faint },
        ...(r.ceiling?.kind === 'tray' || r.ceiling?.kind === 'vaulted' ? [{ text: r.ceiling.kind === 'tray' ? 'Tray ceiling' : 'Vaulted ceiling', size: 9, mono: false, color: pal.faint }] : []),
        accented(r.id, diff?.rooms)
          ? { text: r.id, size: 9, mono: true, weight: 600, color: pal.accentInk, spacing: 0.6, pill: pal.accent }
          : { text: r.id, size: 9, mono: true, color: pal.faint, spacing: 0.6 },
      ];
      labels += placeLabel(r.id, lines, r.outer, r.holes, swings, f);
    }
    scene.unanchored.forEach((u, i) => {
      const lines: LabelLine[] = [
        { text: 'Unanchored', size: 11, mono: false, weight: 500, color: pal.faint },
        { text: `${squareFeet(u.area)} ft²`, size: 10, mono: true, color: pal.faint },
      ];
      labels += placeLabel(`unanchored-${i + 1}`, lines, u.outer, u.holes, swings, f);
    });
    parts.push(el('g', { id: 'labels', 'font-family': SANS }, labels));
  }

  // ── overall exterior dimensions ──
  if (showDims && body) {
    parts.push(el('g', { id: 'dimensions', stroke: pal.muted, 'font-family': MONO, 'font-size': 11 }, dimensions(body, f, pal)));
  }

  // ── title and north arrow ──
  parts.push(
    el('text', { x: margin.left, y: H - 24, 'font-size': 12, 'font-weight': 500, fill: pal.muted }, esc(title)) +
      el('text', { x: margin.left, y: H - 10, 'font-family': MONO, 'font-size': 10, fill: pal.faint }, esc(`${num(scale)} px = 1' 0"`)),
  );
  parts.push(northArrow(W - 30, H - 32, scene.trueNorth, pal));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${SANS}">${parts.join('')}</svg>\n`;
}

/** A polyline ending in an arrowhead at its last point, in drawing coordinates. */
function arrow(pts: readonly XY[], ink: string): string {
  if (pts.length < 2) return '';
  const d = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${num(x)} ${num(y)}`).join('');
  const [x1, y1] = pts[pts.length - 1]!;
  const [x0, y0] = pts[pts.length - 2]!;
  const len = Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0));
  if (len === 0) return el('path', { d, stroke: ink, 'stroke-width': 1, fill: 'none' });
  const ux = (x1 - x0) / len;
  const uy = (y1 - y0) / len;
  const head = `M${num(x1)} ${num(y1)}L${num(x1 - 8 * ux + 4 * uy)} ${num(y1 - 8 * uy - 4 * ux)}L${num(x1 - 8 * ux - 4 * uy)} ${num(y1 - 8 * uy + 4 * ux)}Z`;
  return el('path', { 'data-arrow': 'up', d, stroke: ink, 'stroke-width': 1, fill: 'none' }) + el('path', { d: head, fill: ink });
}

function placeLabel(
  id: string,
  lines: LabelLine[],
  outer: readonly Pt[],
  holes: readonly (readonly Pt[])[],
  obstacles: readonly (readonly Pt[])[],
  f: Frame,
): string {
  const lp = labelPoint(outer, holes, obstacles);
  const span = freeSpan(lp.x, lp.y, [outer, ...holes, ...obstacles]);
  const wPx = span.h * f.s - 12;
  const hPx = span.v * f.s - 12;
  const blockH = (ls: LabelLine[]): number => ls.reduce((sum, l) => sum + l.size * 1.15 + 3, -3);
  const blockW = (ls: LabelLine[]): number => Math.max(...ls.map(lineWidth));
  // Drop the least important lines until the block fits upright, or rotated in a tall room.
  let ls = lines;
  for (;;) {
    if (blockW(ls) <= wPx && blockH(ls) <= hPx) return labelBlock(ls, f.X(lp.x), f.Y(lp.y), false, { 'data-id': id });
    if (hPx > wPx && blockW(ls) <= hPx && blockH(ls) <= wPx) return labelBlock(ls, f.X(lp.x), f.Y(lp.y), true, { 'data-id': id });
    if (ls.length <= 1) return labelBlock(ls, f.X(lp.x), f.Y(lp.y), hPx > wPx * 1.5, { 'data-id': id });
    // Keep the title and the ID longest: drop dimensions, then area, then the ID.
    const drop = [2, 1, 3].find((i) => ls.includes(lines[i]!));
    ls = ls.filter((l) => l !== lines[drop ?? ls.length - 1]);
  }
}

function dimensions(b: Box, f: Frame, pal: Palette): string {
  const x0 = f.X(b.minX);
  const x1 = f.X(b.maxX);
  const yTop = f.Y(b.maxY);
  const yBot = f.Y(b.minY);
  const off = 30;
  const tick = (x: number, y: number): string => linePath([x - 4, y + 4], [x + 4, y - 4]);
  // North side: east–west overall.
  const yd = yTop - off;
  let d = linePath([x0, yTop - 8], [x0, yd - 6]) + linePath([x1, yTop - 8], [x1, yd - 6]) + linePath([x0 - 6, yd], [x1 + 6, yd]);
  const ticks = tick(x0, yd) + tick(x1, yd);
  // West side: north–south overall.
  const xd = x0 - off;
  d += linePath([x0 - 8, yTop], [xd - 6, yTop]) + linePath([x0 - 8, yBot], [xd - 6, yBot]) + linePath([xd, yTop - 6], [xd, yBot + 6]);
  const vticks = tick(xd, yTop) + tick(xd, yBot);
  const text =
    el('text', { x: (x0 + x1) / 2, y: yd - 6, 'text-anchor': 'middle', stroke: 'none', fill: pal.muted }, esc(feetInches(b.maxX - b.minX))) +
    el(
      'text',
      { transform: `translate(${num(xd - 6)} ${num((yTop + yBot) / 2)}) rotate(-90)`, 'text-anchor': 'middle', stroke: 'none', fill: pal.muted },
      esc(feetInches(b.maxY - b.minY)),
    );
  return el('path', { d, 'stroke-width': 0.75, fill: 'none' }) + el('path', { d: ticks + vticks, 'stroke-width': 1.5, fill: 'none' }) + text;
}

/** A north arrow pointing at true north: project north is up, true north `trueNorth` µ° counter-clockwise from it. */
function northArrow(cx: number, cy: number, trueNorth: number, pal: Palette): string {
  const deg = -trueNorth / 1_000_000;
  return el(
    'g',
    { id: 'north', transform: `translate(${num(cx)} ${num(cy)})${deg === 0 ? '' : ` rotate(${num(deg)})`}` },
    el('circle', { r: 13, fill: 'none', stroke: pal.faint, 'stroke-width': 1 }) +
      el('path', { d: 'M0 -10L5.5 7L0 3.5L-5.5 7Z', fill: pal.text }) +
      el('text', { y: -17, 'text-anchor': 'middle', 'font-size': 9, 'font-weight': 600, fill: pal.muted }, 'N'),
  );
}
