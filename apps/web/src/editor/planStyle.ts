import { useSyncExternalStore } from 'react';
import {
  ALL_DETAILS,
  CONSTRUCTION_DOOR,
  PLAN_STYLES,
  STYLES,
  categoryOf,
  defaultStyle,
  finishSource,
  floorFinishOf,
  floorPatternSvg,
  furnitureTone,
  gridPatternSvg,
  hatchPatternSvg,
  isPlanStyle,
  materialTone,
  patternId,
  planTheme,
  wallClassOf,
  wallTypeColour,
  type PlanStyle,
  type PlanTheme,
  type StyleDetails,
  type WallClass,
} from '@floorspec/render2d';
import type { FloorspecDocument } from '@floorspec/engine';
import type { EditorStore, Viewport } from './store';
import type { EditorModel, LevelView } from './model';
import type { DeviceView } from './systems/view';
import { toScreen } from './viewport';
import { modesOf, useModes } from './modes';

/**
 * Plan styles in the editor (FLR-T-18.5): which style the canvas draws in — Colour, Presentation,
 * Technical or Blueprint, from @floorspec/render2d's one theme, the same the plan render and the PDF
 * draw from — its details, and the style an export uses. Kept per project in this browser, as the
 * modes are (the view-state pattern of FLR-T-13.2), never in the model.
 *
 * Construction mode has its own choice, which defaults to Technical (the P18 read-me); every other
 * view shares one, which defaults to Colour. "PDF export only" sets the export's style without
 * changing the canvas.
 */

export { PLAN_STYLES, STYLES, type PlanStyle, type StyleDetails };

export interface PlanStyleState {
  /** Construction mode's style; null for its default, Technical. */
  construction: PlanStyle | null;
  /** Every other view's style; null for the default, Colour. */
  other: PlanStyle | null;
  details: StyleDetails;
  /** The style a PDF and a still are made in when chosen for exports only; null: the canvas's. */
  exportStyle: PlanStyle | null;
}

export const styleKey = (projectId: string): string => `floorspec.style.${projectId}`;

const DETAIL_KEYS = Object.keys(ALL_DETAILS) as (keyof StyleDetails)[];

function read(projectId: string): PlanStyleState {
  const base: PlanStyleState = { construction: null, other: null, details: ALL_DETAILS, exportStyle: null };
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(styleKey(projectId));
    if (raw === null) return base;
    const o = JSON.parse(raw) as Record<string, unknown>;
    const details = { ...ALL_DETAILS };
    if (typeof o['details'] === 'object' && o['details'] !== null)
      for (const k of DETAIL_KEYS) {
        const v = (o['details'] as Record<string, unknown>)[k];
        if (typeof v === 'boolean') details[k] = v;
      }
    return {
      construction: isPlanStyle(o['construction']) ? o['construction'] : null,
      other: isPlanStyle(o['other']) ? o['other'] : null,
      details,
      exportStyle: isPlanStyle(o['exportStyle']) ? o['exportStyle'] : null,
    };
  } catch {
    return base;
  }
}

export class PlanStyleStore {
  private state: PlanStyleState;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly editor: EditorStore) {
    this.state = read(editor.projectId);
  }

  get = (): PlanStyleState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(next: Partial<PlanStyleState>): void {
    this.state = { ...this.state, ...next };
    for (const l of this.listeners) l();
    try {
      localStorage.setItem(styleKey(this.editor.projectId), JSON.stringify(this.state));
    } catch {
      // Storage refused (a private window): the style lasts for this session.
    }
  }

  /** Whether the plan is in Construction mode (or a mode of one's own built on it). */
  private construction(): boolean {
    return modesOf(this.editor).tradeOf() === 'construction';
  }

  /** The style the canvas draws in now. */
  current(): PlanStyle {
    return styleFor(this.state, this.construction());
  }

  /** The style an export is made in. */
  forExport(): PlanStyle {
    return this.state.exportStyle ?? this.current();
  }

  /** Choose a style: for the project's canvas (in this mode's slot), or for exports only. */
  choose(style: PlanStyle, useFor: 'project' | 'export' = 'project'): void {
    if (useFor === 'export') {
      this.set({ exportStyle: style });
      return;
    }
    this.set(this.construction() ? { construction: style, exportStyle: null } : { other: style, exportStyle: null });
  }

  setDetail(key: keyof StyleDetails, on: boolean): void {
    this.set({ details: { ...this.state.details, [key]: on } });
  }
}

/** The style a state draws in, in Construction mode or out of it. */
export function styleFor(state: PlanStyleState, construction: boolean): PlanStyle {
  return construction ? (state.construction ?? defaultStyle('construction')) : (state.other ?? defaultStyle(null));
}

const stores = new WeakMap<EditorStore, PlanStyleStore>();

export function planStylesOf(store: EditorStore): PlanStyleStore {
  let s = stores.get(store);
  if (s === undefined) {
    s = new PlanStyleStore(store);
    stores.set(store, s);
  }
  return s;
}

export function usePlanStyles<T>(store: EditorStore, selector: (s: PlanStyleState) => T): T {
  const s = planStylesOf(store);
  return useSyncExternalStore(s.subscribe, () => selector(s.get()), () => selector(s.get()));
}

/** The canvas's style now: the state's, in the mode the plan is in. */
export function useCurrentStyle(store: EditorStore): PlanStyle {
  const construction = useModes(store, (m) => (m.mode === null ? false : modesOf(store).tradeOf(m.mode) === 'construction'));
  return usePlanStyles(store, (s) => styleFor(s, construction));
}

/** The style an export is made in: the one chosen for exports only, else the canvas's. */
export function useExportStyle(store: EditorStore): PlanStyle {
  const current = useCurrentStyle(store);
  return usePlanStyles(store, (s) => s.exportStyle ?? current);
}

// ─── The page's theme ────────────────────────────────────────────────────────────────────────

const themeOf = (): 'light' | 'dark' => (typeof document !== 'undefined' && document.documentElement.dataset['theme'] === 'dark' ? 'dark' : 'light');

function subscribeTheme(listener: () => void): () => void {
  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return () => undefined;
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => { observer.disconnect(); };
}

/** The page's theme, as the design system sets it on the document. */
export function useDocumentTheme(): 'light' | 'dark' {
  return useSyncExternalStore(subscribeTheme, themeOf, () => 'light');
}

// ─── The look: a style in a theme, as the canvas draws it ────────────────────────────────────

export interface PlanLook {
  readonly style: PlanStyle;
  readonly theme: PlanTheme;
  readonly details: StyleDetails;
  /** Construction mode: walls by type, doors in amber, a legend. */
  readonly byType: boolean;
  /** The CSS custom properties the canvas's stylesheet draws from (planStyle.css). */
  readonly vars: Readonly<Record<string, string>>;
}

export function planLook(style: PlanStyle, themeName: 'light' | 'dark', details: StyleDetails, construction: boolean): PlanLook {
  const t = planTheme(style, themeName);
  const amber = CONSTRUCTION_DOOR[themeName];
  const pill = t.pill !== null && details.pills && t.colour ? t.pill : null;
  const sh = t.shadow !== null && details.shadows ? t.shadow : null;
  return {
    style,
    theme: t,
    details,
    byType: construction,
    vars: {
      '--fsx-paper': t.paper,
      '--fsx-room': t.colour ? t.floorPlain : t.paper,
      '--fsx-wall': t.wallInterior,
      '--fsx-wall-edge': t.wallEdge,
      '--fsx-door': construction ? amber : t.door,
      '--fsx-swing': construction ? amber : t.swing,
      '--fsx-window': t.window,
      '--fsx-glass': t.glass,
      '--fsx-threshold': t.threshold,
      '--fsx-text': t.text,
      '--fsx-muted': t.muted,
      '--fsx-faint': t.faint,
      '--fsx-hair': t.hairline,
      '--fsx-tread': t.tread,
      '--fsx-slab': t.colour ? t.paving : t.paper,
      '--fsx-pill': pill?.fill ?? 'transparent',
      '--fsx-pill-opacity': String(pill?.opacity ?? 0),
      '--fsx-pill-stroke': pill?.stroke ?? 'transparent',
      '--fsx-halo': t.colour ? t.floorPlain : t.paper,
      '--fsx-shadow': sh === null ? 'none' : `drop-shadow(0 ${String(sh.dy)}px ${String(sh.blur)}px ${hexAlpha(sh.color, sh.opacity)})`,
      '--fsx-grid': t.grid === null ? 'var(--color-border)' : hexAlpha(t.grid.color, t.grid.opacity * 2.2),
      '--fsx-weight-wall': String(t.weights.wall),
      '--fsx-weight-door': String(t.weights.door),
      '--fsx-weight-furniture': String(t.weights.furniture),
    },
  };
}

function hexAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${String((n >> 16) & 255)}, ${String((n >> 8) & 255)}, ${String(n & 255)}, ${String(Math.round(a * 100) / 100)})`;
}

// ─── The paint: a level's fills in a look, at this zoom ──────────────────────────────────────

/** The rooms a technical style grids: wet rooms. */
const WET: ReadonlySet<string> = new Set(['bath', 'laundry']);

export interface LevelPaint {
  readonly look: PlanLook;
  /** The `<pattern>`s, hatches and so on the fills below name: render2d's markup, ids prefixed `fsx-`. */
  readonly defs: string;
  /** A room's floor, by its face's floor material (or the plain floor). */
  floor(material: string | undefined): string;
  /** A wet room's grid over its floor, in a technical style. */
  grid(room: string): string | undefined;
  /** A slab's fill. */
  slab(id: string): string;
  /** A wall or junction fill's class and colour, and whether it is hatched. */
  wall(id: string): { cls: WallClass; fill: string; hatch: boolean; type?: string };
  /** Wall types on the level, for the legend: id, name, colour. */
  readonly legend: readonly { id: string; name: string; colour: string }[];
}

type Json = Record<string, unknown>;

export function levelPaint(view: Viewport, level: LevelView, model: EditorModel, look: PlanLook): LevelPaint {
  const doc = model.document as FloorspecDocument & { materials?: Record<string, unknown>; types?: Record<string, unknown>; slabs?: Record<string, Json>; rooms?: Record<string, Json> };
  const t = look.theme;
  const frame = { k: view.s, origin: toScreen(view, [0, 0]) };
  let defs = '';
  const floors = new Map<string, string>();
  const fillOf = (mid: string | undefined): string => {
    if (mid === undefined || !t.colour) return t.colour ? t.floorPlain : t.paper;
    const known = floors.get(mid);
    if (known !== undefined) return known;
    const src = finishSource(mid, doc.materials?.[mid]);
    if (src === undefined) return t.floorPlain;
    const finish = floorFinishOf(src);
    const tone = materialTone(finish.color, t);
    const id = patternId('fsx-floor', mid);
    const def = look.details.patterns ? floorPatternSvg(id, finish, tone, frame, t) : '';
    defs += def;
    const fill = def === '' ? tone : `url(#${id})`;
    floors.set(mid, fill);
    return fill;
  };
  for (const f of level.faces) fillOf(f.floor);
  const slabMaterial = (id: string): string | undefined => {
    const m = doc.slabs?.[id]?.['material'];
    return typeof m === 'string' ? m : undefined;
  };
  for (const s of level.slabs) fillOf(slabMaterial(s.id));
  const grids = new Map<string, string>();
  if (t.linework)
    for (const f of level.faces) {
      if (f.room === null || !WET.has(doc.rooms?.[f.room]?.['function'] ?? '')) continue;
      const src = f.floor === undefined ? undefined : finishSource(f.floor, doc.materials?.[f.floor]);
      const finish = src === undefined ? undefined : floorFinishOf(src);
      const p = finish?.pattern;
      const size: readonly [number, number] = p?.kind === 'tile' ? [p.w, p.h] : p?.kind === 'terrazzo' ? [p.tile, p.tile] : [390_144, 390_144];
      const id = patternId('fsx-grid', f.room);
      const def = gridPatternSvg(id, size, frame, t, finish?.rotation ?? 0);
      if (def !== '') {
        defs += def;
        grids.set(f.room, `url(#${id})`);
      }
    }
  if (t.wallHatch !== null) defs += hatchPatternSvg('fsx-wall-hatch', 4, t.wallHatch, t.weights.hatch);
  if (t.linework) defs += hatchPatternSvg('fsx-slab-hatch', 10, t.hairline, t.weights.hatch);

  // Walls by class (by type in Construction mode); a junction's fill as an exterior wall meeting it.
  const finishes = (model.derived as { finishes?: { walls?: Record<string, { left?: { room?: string }; right?: { room?: string } }> } }).finishes?.walls;
  const classOf = new Map<string, { cls: WallClass; type?: string }>();
  for (const w of level.walls) {
    const sides = finishes?.[w.id];
    const oneRoom = (sides?.left?.room !== undefined) !== (sides?.right?.room !== undefined);
    const cls = wallClassOf(w.type === undefined ? undefined : doc.types?.[w.type]) ?? (oneRoom ? 'exterior' : 'interior');
    classOf.set(w.id, { cls, ...(w.type === undefined ? {} : { type: w.type }) });
    for (const j of [w.start, w.end]) {
      const cur = classOf.get(`junction:${j}`);
      if (cur === undefined || (cur.cls === 'interior' && cls === 'exterior')) classOf.set(`junction:${j}`, { cls, ...(w.type === undefined ? {} : { type: w.type }) });
    }
  }
  const typeColour = new Map<string, string>();
  const legend: { id: string; name: string; colour: string }[] = [];
  for (const w of level.walls) {
    if (w.type === undefined || typeColour.has(w.type)) continue;
    const def = doc.types?.[w.type];
    const cls = classOf.get(w.id)?.cls ?? 'interior';
    const colour = wallTypeColour(def, doc.materials, cls, t);
    typeColour.set(w.type, colour);
    const name = typeof (def as unknown as Json | undefined)?.['name'] === 'string' ? ((def as unknown as Json)['name'] as string) : w.type;
    legend.push({ id: w.type, name, colour });
  }
  legend.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    look,
    defs,
    floor: (m) => fillOf(m),
    grid: (room) => grids.get(room),
    slab: (id) => {
      if (t.linework) return t.paper;
      const m = slabMaterial(id);
      return m === undefined ? t.paving : fillOf(m);
    },
    wall: (id) => {
      const c = classOf.get(id) ?? classOf.get(`junction:${id}`) ?? { cls: 'interior' as const };
      if (look.byType && c.type !== undefined) return { cls: c.cls, fill: typeColour.get(c.type) ?? t.wallInterior, hatch: false, type: c.type };
      return { cls: c.cls, fill: c.cls === 'exterior' ? t.wallExterior : t.wallInterior, hatch: t.wallHatch !== null && c.cls === 'exterior' };
    },
    legend,
  };
}

/** An item's colours in a colour style, as CSS custom properties; none in a line style or with furniture colours off. */
export function furnitureVars(d: DeviceView, look: PlanLook | null): Record<string, string> | undefined {
  if (look === null || !look.theme.colour || !look.details.furniture) return undefined;
  const catalogue = typeof d.element['catalogue'] === 'string' ? d.element['catalogue'] : undefined;
  const tone = furnitureTone(categoryOf(d.element), d.collection, catalogue, look.theme);
  return tone === null ? undefined : { '--fsx-furn-fill': tone.fill, '--fsx-furn-ink': tone.ink };
}
