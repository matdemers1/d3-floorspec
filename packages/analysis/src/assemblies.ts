/**
 * Assemblies, layer by layer (FLR-T-16.4): every wall type's, roof's and floor's thermal resistance and
 * U-factor, from FS_thermal 0.1.0's data (registry/FS_thermal/spec.md) as the engine derives it — each
 * layer's resistance and heat capacity, and each assembly's clear and framed paths (FS_thermal 3.1,
 * 3.2, exact) — and from there, by a method this module names:
 *
 * - **Surface resistances** (ASHRAE Handbook — Fundamentals' still-air and 15 mph winter values, in
 *   m²·K/W): a wall's inside 0.12 and outside 0.03; a roof's or ceiling's inside 0.11 (heat flowing up)
 *   and outside 0.03; a floor's inside 0.16 (heat flowing down) and, over a crawl space or a garage,
 *   0.16 again; any face to an unconditioned room, 0.12.
 * - **Parallel paths** (ASHRAE's parallel-path method, FS_thermal 3.3): U = (1 − f)/R₁ + f/R₂, with
 *   each path's total resistance R = films + the path's layers, and f the framing's share.
 * - **Framing** is the type's FS_thermal framing; else FS_structural's studs on a wall of the type
 *   (ASHRAE 90.1 Appendix A's framing fractions: 25% at 16 in on centre or closer, 22% at 24 in);
 *   else, for a core layer that is a cavity (an insulated or empty stud cavity, by the thermal
 *   library), 25% softwood — assumed, and said so.
 * - **Materials with no FS_thermal data** take the thermal library's typical value for what they are
 *   (thermal-library.ts, by the material's ID or its library item), and the result says which.
 *
 * A window's or door's U-factor and SHGC are its type's FS_thermal rating (2.5). Thermal mass is the
 * assembly's heat capacity per square metre, the paths weighted by area. Advisory: values to compare
 * options, never an energy-code calculation (FLR-ADR-011).
 */
import { deriveAssembly, thermalOf, type DerivedAssembly, type FloorspecDocument, type ThermalFraming, type ThermalLayer } from '@floorspec/engine';
import { thermalItem, thermalMatch, thermalData, type ThermalLibraryItem } from './thermal-library.js';

/** Imperial R (h·ft²·°F/Btu) per SI R (m²·K/W). */
export const R_SI_TO_IP = 5.678263;
/** J/(m²·K) per Btu/(ft²·°F). */
export const HEAT_CAPACITY_IP = 20441.7;

export type Position = 'wall' | 'roof' | 'floor';
export type Toward = 'outside' | 'unconditioned';

/** ASHRAE's surface resistances, m²·K/W. */
export const FILMS = {
  wall: { inside: 0.12, outside: 0.03 },
  roof: { inside: 0.11, outside: 0.03 },
  floor: { inside: 0.16, outside: 0.16 },
  unconditioned: 0.12,
} as const;

/** ASHRAE 90.1 Appendix A's framing fractions for wood studs. */
export const FRAMING_16_OC = 0.25;
export const FRAMING_24_OC = 0.22;

export const PARALLEL_PATH = 'ASHRAE parallel-path method with ASHRAE Fundamentals surface resistances';

/** Where a value came from. */
export type ValueSource = 'document' | 'library' | 'unknown';

export interface LayerThermal {
  readonly index: number;
  readonly function: string;
  /** Base units. */
  readonly thickness: number;
  readonly material?: string;
  readonly materialName?: string;
  /** The layer's resistance, m²·K/W (FS_thermal 3.1), or null when not known. */
  readonly r: number | null;
  /** J/(m²·K). */
  readonly heatCapacity: number | null;
  readonly source: ValueSource;
  /** The library item a value came from, when `source` is `library`. */
  readonly libraryItem?: string;
}

export interface FramingThermal {
  readonly material?: string;
  readonly materialName: string;
  /** 0 to 1. */
  readonly fraction: number;
  readonly source: 'document' | 'structural' | 'assumed';
  readonly text: string;
}

export interface AssemblyThermal {
  /** `wall:<type>`, `roof:<roof>`, `floor:<room>`. */
  readonly key: string;
  readonly id: string;
  readonly position: Position;
  readonly label: string;
  readonly layers: LayerThermal[];
  readonly framing?: FramingThermal;
  /** Each path's layers, m²·K/W, without films; null when not known. */
  readonly rClear: number | null;
  readonly rFramed: number | null;
  readonly films: { readonly inside: number; readonly outside: number };
  /** The effective R with films, m²·K/W, and its U, W/(m²·K); null when not known. */
  readonly rEffective: number | null;
  readonly u: number | null;
  /** J/(m²·K), the paths weighted by area; null when not known. */
  readonly heatCapacity: number | null;
  /** Every value from the document's own FS_thermal data. */
  readonly fromDocument: boolean;
  readonly method: string;
}

/** A collection's members in ID order. */
function entries<T>(c: Record<string, T | undefined> | undefined): [string, T][] {
  return c === undefined ? [] : Object.keys(c).sort().map((k) => [k, c[k] as T]);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nameOf = (doc: FloorspecDocument, id: string | undefined): string | undefined => (id === undefined ? undefined : ((doc.materials as Record<string, { name?: string }> | undefined)?.[id]?.name ?? id));

/** The ID the analysis gives the framing material it assumes (never written to a document). */
const ASSUMED_FRAMING = '\u0000assumed-framing';

/**
 * The document as the thermal analysis reads it: every material with its own FS_thermal data, or the
 * thermal library's typical data where it has none and the library knows what it is. `filled` names
 * the materials whose values came from the library.
 */
export interface ThermalView {
  readonly doc: FloorspecDocument;
  readonly filled: ReadonlyMap<string, ThermalLibraryItem>;
}

export function thermalView(doc: FloorspecDocument): ThermalView {
  const mats = (doc.materials ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const filled = new Map<string, ThermalLibraryItem>();
  for (const [id, m] of Object.entries(mats)) {
    const own = thermalOf(m);
    const hasR = own !== undefined && (Object.hasOwn(own, 'conductivity') || Object.hasOwn(own, 'resistance'));
    const item = hasR ? undefined : thermalMatch(id, m);
    if (item !== undefined) {
      filled.set(id, item);
      const ext = isObject(m) && isObject(m['extensions']) ? m['extensions'] : {};
      out[id] = { ...(isObject(m) ? m : {}), extensions: { ...ext, FS_thermal: { ...thermalData(item), ...(own ?? {}) } } };
    } else out[id] = m;
  }
  const framing = thermalItem('softwood-framing')!;
  out[ASSUMED_FRAMING] = { name: framing.name, extensions: { FS_thermal: thermalData(framing) } };
  return { doc: { ...doc, materials: out } as FloorspecDocument, filled };
}

/** The layer is a cavity a framing replaces: its material is one the thermal library calls a cavity. */
function isCavity(view: ThermalView, material: string | undefined): boolean {
  if (material === undefined) return false;
  const item = view.filled.get(material) ?? thermalMatch(material, (view.doc.materials as Record<string, unknown>)[material]);
  return item?.cavity === true;
}

/** FS_structural's stud spacing on a wall of this type, when one says. */
function structuralSpacing(doc: FloorspecDocument, typeId: string): { spacing: number; material: string } | undefined {
  for (const [, w] of entries(doc.walls)) {
    if (w.type !== typeId) continue;
    const f = (isObject(w.extensions) && isObject(w.extensions['FS_structural']) ? w.extensions['FS_structural']['framing'] : undefined) as { system?: string; spacing?: number; material?: string } | undefined;
    if (f?.system === 'studs' && typeof f.spacing === 'number') return { spacing: f.spacing, material: f.material ?? 'wood' };
  }
  return undefined;
}

const IN = 32512;

function framingOf(view: ThermalView, own: ThermalFraming | undefined, layers: readonly ThermalLayer[], typeId?: string): { framing?: ThermalFraming; info?: FramingThermal } {
  if (own !== undefined) {
    return { framing: own, info: { material: own.material, materialName: nameOf(view.doc, own.material) ?? own.material, fraction: own.fraction / 1000, source: 'document', text: `${String(Math.round(own.fraction / 10))}% ${nameOf(view.doc, own.material) ?? own.material}, as the document states` } };
  }
  if (!layers.some((l) => l.function === 'core' && isCavity(view, l.material))) return {};
  const s = typeId === undefined ? undefined : structuralSpacing(view.doc, typeId);
  if (s !== undefined && s.material === 'wood') {
    const f = s.spacing <= 16 * IN ? FRAMING_16_OC : FRAMING_24_OC;
    return { framing: { material: ASSUMED_FRAMING, fraction: Math.round(f * 1000) }, info: { materialName: 'Softwood framing', fraction: f, source: 'structural', text: `${String(Math.round(f * 100))}% softwood: FS_structural's studs at ${String(Math.round(s.spacing / IN))} in on centre (ASHRAE 90.1 Appendix A's framing fraction)` } };
  }
  return { framing: { material: ASSUMED_FRAMING, fraction: Math.round(FRAMING_16_OC * 1000) }, info: { materialName: 'Softwood framing', fraction: FRAMING_16_OC, source: 'assumed', text: '25% softwood at 16 in on centre, assumed (ASHRAE 90.1 Appendix A\'s framing fraction): the document states no framing' } };
}

/** Films for an assembly in a position, toward the outside or an unconditioned room. */
export function filmsOf(position: Position, toward: Toward): { inside: number; outside: number } {
  const f = FILMS[position];
  return toward === 'outside' ? { inside: f.inside, outside: f.outside } : { inside: f.inside, outside: FILMS.unconditioned };
}

/** U from the paths: (1 − f)/(films + R₁) + f/(films + R₂). */
export function parallelU(rClear: number, rFramed: number | null, fraction: number, films: { inside: number; outside: number }): number {
  const fs = films.inside + films.outside;
  return rFramed === null || fraction === 0 ? 1 / (fs + rClear) : (1 - fraction) / (fs + rClear) + fraction / (fs + rFramed);
}

/** One assembly's thermal values, layer by layer, for a position and what it faces. */
export function assemblyThermal(view: ThermalView, key: string, id: string, position: Position, label: string, layers: readonly ThermalLayer[], ownFraming: ThermalFraming | undefined, toward: Toward = 'outside', typeId?: string): AssemblyThermal {
  const { framing, info } = framingOf(view, ownFraming, layers, typeId);
  const d: DerivedAssembly = deriveAssembly(view.doc, layers, framing);
  const films = filmsOf(position, toward);
  const out: LayerThermal[] = layers.map((l, i) => {
    const v = d.layers[i]!;
    const item = l.material === undefined ? undefined : view.filled.get(l.material);
    return {
      index: i,
      function: l.function,
      thickness: l.thickness,
      ...(l.material === undefined ? {} : { material: l.material, materialName: nameOf(view.doc, l.material)! }),
      r: v.resistance === null ? null : v.resistance / 1000,
      heatCapacity: v.heatCapacity,
      source: v.resistance === null ? 'unknown' : item !== undefined ? 'library' : 'document',
      ...(item === undefined ? {} : { libraryItem: item.id }),
    };
  });
  const rClear = d.clear.resistance === null ? null : d.clear.resistance / 1000;
  const rFramed = d.framed?.resistance === null || d.framed === undefined ? null : d.framed.resistance / 1000;
  const f = info?.fraction ?? 0;
  const u = rClear === null || (f > 0 && rFramed === null) ? null : parallelU(rClear, rFramed, f, films);
  const hc = d.clear.heatCapacity === null ? null : f > 0 ? (d.framed?.heatCapacity === null || d.framed === undefined ? null : (1 - f) * d.clear.heatCapacity + f * d.framed.heatCapacity) : d.clear.heatCapacity;
  const fromDocument = out.every((l) => l.source === 'document') && (info === undefined || info.source === 'document');
  return {
    key,
    id,
    position,
    label,
    layers: out,
    ...(info === undefined ? {} : { framing: info }),
    rClear,
    rFramed,
    films,
    rEffective: u === null ? null : 1 / u,
    u,
    heatCapacity: hc,
    fromDocument,
    method: `${f > 0 ? PARALLEL_PATH : 'Layers in series with ASHRAE Fundamentals surface resistances'} (films ${films.inside.toFixed(2)} + ${films.outside.toFixed(2)} m²·K/W)`,
  };
}

const layersOf = (v: unknown): ThermalLayer[] | undefined => (Array.isArray(v) ? (v as ThermalLayer[]) : undefined);

/** A wall type's assembly. */
export function wallTypeThermal(view: ThermalView, typeId: string, toward: Toward = 'outside'): AssemblyThermal | undefined {
  const t = (view.doc.types as Record<string, { kind: string; name?: string; layers?: ThermalLayer[] }> | undefined)?.[typeId];
  if (t?.kind !== 'wallType' || !t.layers) return undefined;
  const own = thermalOf(t)?.['framing'] as ThermalFraming | undefined;
  return assemblyThermal(view, `wall:${typeId}`, typeId, 'wall', t.name ?? typeId, t.layers, own, toward, typeId);
}

/** A roof's assembly, when its FS_thermal data has layers. */
export function roofThermal(view: ThermalView, roofId: string): AssemblyThermal | undefined {
  const r = (view.doc.roofs as Record<string, { name?: string }> | undefined)?.[roofId];
  const v = thermalOf(r);
  const layers = layersOf(v?.['layers']);
  if (!layers) return undefined;
  return assemblyThermal(view, `roof:${roofId}`, roofId, 'roof', r?.name ?? roofId, layers, v?.['framing'] as ThermalFraming | undefined);
}

/** A room's floor assembly, when its FS_thermal floor has layers. */
export function floorThermal(view: ThermalView, roomId: string, toward: Toward = 'outside'): AssemblyThermal | undefined {
  const r = view.doc.rooms?.[roomId];
  const f = thermalOf(r)?.['floor'];
  const layers = isObject(f) ? layersOf(f['layers']) : undefined;
  if (!layers || !isObject(f)) return undefined;
  return assemblyThermal(view, `floor:${roomId}`, roomId, 'floor', `${r?.name ?? roomId} floor`, layers, f['framing'] as ThermalFraming | undefined, toward);
}

/** A room's floor's edge insulation, m²·K/W, when FS_thermal states it. */
export function edgeResistanceOf(doc: FloorspecDocument, roomId: string): number | undefined {
  const f = thermalOf(doc.rooms?.[roomId])?.['floor'];
  return isObject(f) && typeof f['edgeResistance'] === 'number' ? f['edgeResistance'] / 1000 : undefined;
}

/** A door or window type's rating (FS_thermal 2.5): U in W/(m²·K), SHGC 0–1. */
export function unitThermal(doc: FloorspecDocument, typeId: string | undefined): { u?: number; shgc?: number } {
  if (typeId === undefined) return {};
  const v = thermalOf((doc.types as Record<string, unknown> | undefined)?.[typeId]);
  return {
    ...(typeof v?.['uFactor'] === 'number' ? { u: v['uFactor'] / 1000 } : {}),
    ...(typeof v?.['shgc'] === 'number' ? { shgc: v['shgc'] / 1000 } : {}),
  };
}

/** F-factor of a slab edge, W/(m·K): ASHRAE 90.1 Appendix A's F-0.73 uninsulated and F-0.54 at R-10 (24 in vertical), linear between, R-10's beyond. */
export function slabF(edgeResistanceSI: number): number {
  const rIp = edgeResistanceSI * R_SI_TO_IP;
  const fIp = rIp >= 10 ? 0.54 : 0.73 - (0.19 * rIp) / 10;
  return fIp * 1.730735;
}

/** Every wall type's, roof's and floor's assembly in the document. */
export function documentAssemblies(doc: FloorspecDocument): AssemblyThermal[] {
  const view = thermalView(doc);
  const out: AssemblyThermal[] = [];
  for (const [id, t] of entries(doc.types)) if (t.kind === 'wallType') out.push(wallTypeThermal(view, id)!);
  for (const [id] of entries(doc.roofs as Record<string, unknown> | undefined)) {
    const a = roofThermal(view, id);
    if (a) out.push(a);
  }
  for (const [id] of entries(doc.rooms)) {
    const a = floorThermal(view, id);
    if (a) out.push(a);
  }
  return out;
}

/** R in inch-pounds, as the trade writes it: R-24, R-0.6. */
export function rText(rSI: number): string {
  const r = rSI * R_SI_TO_IP;
  return `R-${r >= 10 ? String(Math.round(r)) : r >= 1 ? (Math.round(r * 10) / 10).toFixed(1).replace(/\.0$/, '') : (Math.round(r * 10) / 10).toFixed(1)}`;
}

/** U in inch-pounds: U-0.042. */
export function uText(uSI: number): string {
  const u = uSI / R_SI_TO_IP;
  return `U-${u >= 0.1 ? u.toFixed(2) : u.toFixed(3)}`;
}
