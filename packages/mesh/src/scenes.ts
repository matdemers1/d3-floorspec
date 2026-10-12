/**
 * Lighting scenes (FLR-T-13.12, FS_lighting 0.1.0, FLR-ADR-043): which of a house's lights are on,
 * at what output and colour temperature — one resolution every view reads, so the editor's 3D view,
 * the path tracer, the glTF export (and the GPU still that reads it) and the headless render show
 * the same scene the same way.
 *
 * A **lighting** is either every light at full (`ALL_ON`, what a view showed before scenes) or an
 * explicit list of the lights that are on, each with an output (1–100 % of full) and, optionally, a
 * colour temperature; every light it does not list is off. A document's scenes are FS_lighting's
 * `scenes`, each a lighting with a name; "All on" and "Off" are built in and never stored.
 */
import type { FloorspecDocument } from '@floorspec/engine';

/** How a lighting sets one light it turns on (FS_lighting 3.1). */
export interface SceneSetting {
  /** Percent of full output, 1–100; default 100. */
  readonly output?: number;
  /** Kelvin; default the light's own. */
  readonly cct?: number;
}

/** What is on: every light at full, or exactly these, each at its setting. */
export type Lighting = { readonly all: true } | { readonly on: Readonly<Record<string, SceneSetting>> };

export const ALL_ON: Lighting = Object.freeze({ all: true as const });
export const ALL_OFF: Lighting = Object.freeze({ on: Object.freeze({}) });

/** The built-in scenes' names. */
export const ALL_ON_NAME = 'All on';
export const OFF_NAME = 'Off';

/** A scene a view offers: a document's (its ID) or a built-in one (`id` null). */
export interface NamedScene {
  readonly id: string | null;
  readonly name: string;
  readonly lighting: Lighting;
}

/** FS_lighting 1.4: kelvin a lighting may name (the schema's range). */
export const CCT_MIN = 1000;
export const CCT_MAX = 10000;
/** The range a colour-temperature control offers for a luminaire that says nothing about its own. */
export const CCT_SLIDER: readonly [number, number] = [2200, 6500];

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** FS_lighting's data, when the document declares FS_lighting; else undefined. */
export function lightingData(doc: FloorspecDocument): { luminaires: Record<string, Json>; scenes: Record<string, Json> } | undefined {
  const used = (doc as { extensionsUsed?: unknown }).extensionsUsed;
  if (!isObject(used) || !Object.hasOwn(used, 'FS_lighting')) return undefined;
  const data = (doc.extensions as Json | undefined)?.['FS_lighting'];
  if (!isObject(data)) return { luminaires: {}, scenes: {} };
  return { luminaires: isObject(data['luminaires']) ? (data['luminaires'] as Record<string, Json>) : {}, scenes: isObject(data['scenes']) ? (data['scenes'] as Record<string, Json>) : {} };
}

/** A luminaire's own photometry (FS_lighting 2.1), what of it the document records. */
export interface LuminaireData {
  readonly lumens?: number;
  readonly cct?: number;
  readonly cctRange?: readonly [number, number];
  readonly dimmable?: boolean;
}

/** FS_lighting's luminaire records, by light ID. */
export function luminairesOf(doc: FloorspecDocument): ReadonlyMap<string, LuminaireData> {
  const out = new Map<string, LuminaireData>();
  for (const [id, l] of Object.entries(lightingData(doc)?.luminaires ?? {})) {
    if (!isObject(l)) continue;
    const range = Array.isArray(l['cctRange']) && l['cctRange'].length === 2 && l['cctRange'].every((k) => typeof k === 'number') ? (l['cctRange'] as [number, number]) : undefined;
    out.set(id, {
      ...(typeof l['lumens'] === 'number' && l['lumens'] > 0 ? { lumens: l['lumens'] } : {}),
      ...(typeof l['cct'] === 'number' ? { cct: l['cct'] } : {}),
      ...(range === undefined ? {} : { cctRange: range }),
      ...(typeof l['dimmable'] === 'boolean' ? { dimmable: l['dimmable'] } : {}),
    });
  }
  return out;
}

const clampOutput = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(1, Math.round(v))) : 100);
const clampCct = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.min(CCT_MAX, Math.max(CCT_MIN, Math.round(v))) : undefined);

/** A lighting's `on`, every setting made well-formed: output 1–100, colour temperature within FS_lighting's range. */
export function normalizeOn(on: unknown): Record<string, SceneSetting> {
  const out: Record<string, SceneSetting> = {};
  if (!isObject(on)) return out;
  for (const id of Object.keys(on).sort()) {
    const s = on[id];
    const output = clampOutput(isObject(s) ? s['output'] : undefined);
    const cct = clampCct(isObject(s) ? s['cct'] : undefined);
    Object.defineProperty(out, id, { value: { ...(output === 100 ? {} : { output }), ...(cct === undefined ? {} : { cct }) }, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** The document's own scenes (FS_lighting `scenes`), in ID order. */
export function documentScenes(doc: FloorspecDocument): NamedScene[] {
  const scenes = lightingData(doc)?.scenes ?? {};
  return Object.keys(scenes)
    .sort()
    .flatMap((id) => {
      const s = scenes[id];
      if (!isObject(s) || typeof s['name'] !== 'string') return [];
      return [{ id, name: s['name'], lighting: { on: normalizeOn(s['on']) } }];
    });
}

/** Every scene a view offers: "All on", the document's own, "Off" — a document's scene of a built-in's name takes its place. */
export function scenesOf(doc: FloorspecDocument): NamedScene[] {
  const own = documentScenes(doc);
  const named = (n: string) => own.some((s) => s.name.toLowerCase() === n.toLowerCase());
  return [
    ...(named(ALL_ON_NAME) ? [] : [{ id: null, name: ALL_ON_NAME, lighting: ALL_ON }]),
    ...own,
    ...(named(OFF_NAME) ? [] : [{ id: null, name: OFF_NAME, lighting: ALL_OFF }]),
  ];
}

/** A scene by name — exactly, then ignoring case; "on" and "off" are the built-ins'. Undefined when none is. */
export function sceneNamed(doc: FloorspecDocument, name: string): NamedScene | undefined {
  const all = scenesOf(doc);
  const exact = all.find((s) => s.name === name);
  if (exact !== undefined) return exact;
  const lower = name.trim().toLowerCase();
  const folded = all.find((s) => s.name.toLowerCase() === lower);
  if (folded !== undefined) return folded;
  if (lower === 'on' || lower === 'all') return all.find((s) => s.lighting === ALL_ON);
  if (lower === 'none') return all.find((s) => s.lighting === ALL_OFF);
  return undefined;
}

/** How a lighting sets one light: null when it is off. */
export function settingOf(lighting: Lighting, id: string): { readonly output: number; readonly cct?: number } | null {
  if ('all' in lighting) return { output: 100 };
  if (!Object.hasOwn(lighting.on, id)) return null;
  const s = lighting.on[id]!;
  return { output: s.output ?? 100, ...(s.cct === undefined ? {} : { cct: s.cct }) };
}

/** Do two lightings turn on the same lights at the same settings? (`ids`: every light, to expand "All on".) */
export function sameLighting(a: Lighting, b: Lighting, ids: readonly string[]): boolean {
  for (const id of ids) {
    const x = settingOf(a, id);
    const y = settingOf(b, id);
    if ((x === null) !== (y === null)) return false;
    if (x !== null && y !== null && (x.output !== y.output || x.cct !== y.cct)) return false;
  }
  return true;
}

/** A lighting as an explicit list over `ids` (expanding "All on"), ready to change one light of. */
export function explicit(lighting: Lighting, ids: readonly string[]): Record<string, SceneSetting> {
  if (!('all' in lighting)) return { ...lighting.on };
  const out: Record<string, SceneSetting> = {};
  for (const id of ids) out[id] = {};
  return out;
}

/** `lighting` with each of `ids` turned on (at its setting, or full) or off. */
export function withLights(lighting: Lighting, all: readonly string[], ids: readonly string[], on: boolean): Lighting {
  const next = explicit(lighting, all);
  const off = new Set(on ? [] : ids);
  if (on) for (const id of ids) next[id] ??= {};
  return { on: normalizeOn(Object.fromEntries(Object.entries(next).filter(([id]) => !off.has(id)))) };
}

/** `lighting` with one light set: its output and colour temperature (turning it on). */
export function withSetting(lighting: Lighting, all: readonly string[], id: string, setting: SceneSetting): Lighting {
  const next = explicit(lighting, all);
  next[id] = { ...(next[id] ?? {}), ...setting };
  return { on: normalizeOn(next) };
}

/**
 * A switch's toggle (FLR-T-13.12): what it controls turns off when any of it is on, else on — as a
 * wall switch does to a room whose lamps another switch left half on.
 */
export function toggled(lighting: Lighting, all: readonly string[], controls: readonly string[]): Lighting {
  const any = controls.some((id) => settingOf(lighting, id) !== null);
  return withLights(lighting, all, controls, !any);
}
