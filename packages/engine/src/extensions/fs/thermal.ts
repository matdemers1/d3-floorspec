/**
 * FS_thermal 0.1.0 (registry/FS_thermal/spec.md, Draft, FLR-ADR-066): what materials conduct and store,
 * the framing through a wall type's core layers, the layered assemblies of roofs and rooms' floors, and
 * the whole-unit U-factor and SHGC of door and window types. It adds no kind of element: its data is
 * each material's, type's, roof's and room's own `extensions.FS_thermal` (Core 12.7), checked as
 * `{ <collection>: data }` — a type's as `{ <kind>: data }` — against the schema's `#/$defs/coreElements`.
 *
 * What it derives is exact (3.1): a layer's resistance is 25 t / (32 k) thousandths of m²·K/W and its
 * heat capacity t × density × specific heat / 1,280,000 J/(m²·K), each rounded once, ties to even;
 * an assembly's clear and framed paths are sums of its layers' rounded values (3.2). U-factors, air
 * films, heat loss and loads are a method's (3.3) — @floorspec/analysis's, advisory — never this.
 */
import { validate as validateTop } from '../../generated/validate-FS_thermal.js';
import { validate as validateCore } from '../../generated/validate-FS_thermal-core.js';
import { entries, type FloorspecDocument } from '../../model/document.js';
import { record, type ExtensionContext, type ExtensionImplementation } from '../context.js';

export const FS_THERMAL_NAME = 'FS_thermal';
const NAME = FS_THERMAL_NAME;
/** 1.3: the collections whose elements carry data checked as `{ C: data }`. */
const DEFINED = ['materials', 'roofs', 'rooms'] as const;
/** 1.3.3: every other collection whose elements have an `extensions` member. */
const OTHERS = ['buildings', 'levels', 'junctions', 'walls', 'separators', 'openings', 'slabs', 'assets', 'stairs', 'optionSets', 'options'] as const;

type Json = Record<string, unknown>;

/** A Core layer, as FS_thermal reads it (2.2). */
export interface ThermalLayer {
  readonly thickness: number;
  readonly function: string;
  readonly material?: string;
}

/** A framing (2.2): its material, and the thousandths of the assembly's area it takes. */
export interface ThermalFraming {
  readonly material: string;
  readonly fraction: number;
}

/** A material's FS_thermal data (2.1). */
export interface MaterialThermal {
  readonly conductivity?: number;
  readonly resistance?: number;
  readonly density?: number;
  readonly specificHeat?: number;
  readonly solarReflectance?: number;
  readonly emittance?: number;
  readonly citation?: string;
}

/** A door or window type's FS_thermal data (2.5). */
export interface UnitThermal {
  readonly uFactor?: number;
  readonly shgc?: number;
}

/** A room's floor's FS_thermal data (2.4). */
export interface FloorThermal {
  readonly layers?: readonly ThermalLayer[];
  readonly framing?: ThermalFraming;
  readonly edgeResistance?: number;
}

/** One layer's derived values (3.1): `null` where not known. */
export interface DerivedLayer {
  resistance: number | null;
  heatCapacity: number | null;
}

/** An assembly's derived values (5.1). */
export interface DerivedAssembly {
  layers: DerivedLayer[];
  clear: DerivedLayer;
  framed?: DerivedLayer & { fraction: number };
}

/** What FS_thermal derives (chapter 5). */
export interface DerivedThermal {
  wallTypes: Record<string, DerivedAssembly>;
  roofs: Record<string, DerivedAssembly>;
  floors: Record<string, DerivedAssembly>;
}

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** An element's own FS_thermal data, when it has some. */
export function thermalOf(el: unknown): Json | undefined {
  const x = isObject(el) ? el['extensions'] : undefined;
  const v = isObject(x) ? x[NAME] : undefined;
  return isObject(v) ? v : undefined;
}

const has = (el: unknown): boolean => isObject(el) && isObject(el['extensions']) && Object.hasOwn(el['extensions'], NAME);

/** 1.3.1 to 1.3.3: the top-level data, the data on every element against #/$defs/coreElements, and none elsewhere. */
function validate(data: unknown, document?: unknown): boolean {
  if (!validateTop(data)) return false;
  if (!isObject(document)) return true;
  for (const c of DEFINED) {
    const coll = document[c];
    if (!isObject(coll)) continue;
    for (const el of Object.values(coll)) if (has(el) && !validateCore({ [c]: (el as { extensions: Json }).extensions[NAME] })) return false;
  }
  const types = document['types'];
  if (isObject(types))
    for (const t of Object.values(types))
      if (has(t)) {
        const kind = isObject(t) ? t['kind'] : undefined;
        if (typeof kind !== 'string' || !validateCore({ [kind]: (t as { extensions: Json }).extensions[NAME] })) return false;
      }
  for (const c of OTHERS) {
    const coll = document[c];
    if (isObject(coll)) for (const el of Object.values(coll)) if (has(el)) return false;
  }
  const items = isObject(document['program']) ? document['program']['items'] : undefined;
  if (isObject(items)) for (const el of Object.values(items)) if (has(el)) return false;
  return true;
}

/** round(num / den), ties to even, exactly (Core 2.2); den > 0, num ≥ 0. */
function roundHalfEven(num: bigint, den: bigint): number {
  const q = num / den;
  const r2 = (num % den) * 2n;
  const up = r2 > den || (r2 === den && q % 2n === 1n);
  return Number(up ? q + 1n : q);
}

/** A material's FS_thermal data, or undefined when the document has no such material. */
export function materialThermal(doc: FloorspecDocument, material: string | undefined): MaterialThermal | undefined {
  if (material === undefined) return undefined;
  const mats = doc.materials as Record<string, unknown> | undefined;
  if (!mats || !Object.hasOwn(mats, material)) return undefined;
  return (thermalOf(mats[material]) ?? {});
}

/** 3.1: a layer of `thickness` (base units) made of `material`: its resistance and heat capacity. */
export function layerValues(doc: FloorspecDocument, thickness: number, material: string | undefined): DerivedLayer {
  const t = materialThermal(doc, material);
  if (t === undefined) return { resistance: null, heatCapacity: null };
  const th = BigInt(thickness);
  const resistance = t.resistance !== undefined ? t.resistance : t.conductivity !== undefined ? roundHalfEven(25n * th, 32n * BigInt(t.conductivity)) : null;
  const heatCapacity = t.density !== undefined && t.specificHeat !== undefined ? roundHalfEven(th * BigInt(t.density) * BigInt(t.specificHeat), 1_280_000n) : null;
  return { resistance, heatCapacity };
}

const sumOf = (xs: readonly (number | null)[]): number | null => (xs.some((x) => x === null) ? null : xs.reduce<number>((s, x) => s + x!, 0));

/** 3.2, 5.1: an assembly's derived values — its layers, its clear path and, with a framing, its framed path. */
export function deriveAssembly(doc: FloorspecDocument, layers: readonly ThermalLayer[], framing?: ThermalFraming): DerivedAssembly {
  const vals = layers.map((l) => layerValues(doc, l.thickness, l.material));
  const out: DerivedAssembly = {
    layers: vals,
    clear: { resistance: sumOf(vals.map((v) => v.resistance)), heatCapacity: sumOf(vals.map((v) => v.heatCapacity)) },
  };
  if (framing !== undefined) {
    const fv = layers.map((l, i) => (l.function === 'core' ? layerValues(doc, l.thickness, framing.material) : vals[i]!));
    out.framed = { fraction: framing.fraction, resistance: sumOf(fv.map((v) => v.resistance)), heatCapacity: sumOf(fv.map((v) => v.heatCapacity)) };
  }
  return out;
}

/** An assembly of chapter 5: where it is derived, its carrier's ID, its layers and its framing. */
export interface ThermalAssembly {
  readonly section: 'wallTypes' | 'roofs' | 'floors';
  readonly id: string;
  readonly layers: readonly ThermalLayer[];
  readonly framing?: ThermalFraming;
}

/** 5.1: every assembly — every wall type, every roof whose data has layers, every room whose floor has. */
export function thermalAssemblies(doc: FloorspecDocument): ThermalAssembly[] {
  const out: ThermalAssembly[] = [];
  for (const [id, t] of entries(doc.types))
    if (t.kind === 'wallType') {
      const f = thermalOf(t)?.['framing'] as ThermalFraming | undefined;
      out.push({ section: 'wallTypes', id, layers: t.layers, ...(f === undefined ? {} : { framing: f }) });
    }
  for (const [id, r] of entries(doc.roofs as Record<string, unknown> | undefined)) {
    const v = thermalOf(r);
    if (v !== undefined && Array.isArray(v['layers']))
      out.push({ section: 'roofs', id, layers: v['layers'] as ThermalLayer[], ...(isObject(v['framing']) ? { framing: v['framing'] as unknown as ThermalFraming } : {}) });
  }
  for (const [id, r] of entries(doc.rooms)) {
    const f = thermalOf(r)?.['floor'];
    if (isObject(f) && Array.isArray(f['layers']))
      out.push({ section: 'floors', id, layers: f['layers'] as ThermalLayer[], ...(isObject(f['framing']) ? { framing: f['framing'] as unknown as ThermalFraming } : {}) });
  }
  return out;
}

function invariants(ctx: ExtensionContext): void {
  const doc = ctx.doc;
  for (const [id, m] of entries(doc.materials as Record<string, unknown> | undefined)) {
    const v = thermalOf(m);
    if (v !== undefined && Object.hasOwn(v, 'conductivity') && Object.hasOwn(v, 'resistance'))
      ctx.report('FS-THRM-INV-001', `${id} states both a conductivity and a resistance.`, [id]);
  }
  const mats = (doc.materials ?? {}) as Record<string, unknown>;
  const refs = (v: Json): string[] => {
    const out: string[] = [];
    if (Array.isArray(v['layers'])) for (const l of v['layers'] as ThermalLayer[]) if (l.material !== undefined) out.push(l.material);
    if (isObject(v['framing'])) out.push(String(v['framing']['material']));
    return out;
  };
  const carriers: [string, Json | undefined][] = [
    ...entries(doc.types).map(([id, t]): [string, Json | undefined] => [id, thermalOf(t)]),
    ...entries(doc.roofs as Record<string, unknown> | undefined).map(([id, r]): [string, Json | undefined] => [id, thermalOf(r)]),
    ...entries(doc.rooms).map(([id, r]): [string, Json | undefined] => {
      const f = thermalOf(r)?.['floor'];
      return [id, isObject(f) ? f : undefined];
    }),
  ];
  for (const [id, v] of carriers.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    if (v !== undefined && refs(v).some((m) => !Object.hasOwn(mats, m))) ctx.report('FS-THRM-INV-002', `${id}'s FS_thermal data names a material the document does not have.`, [id]);
}

function lints(ctx: ExtensionContext): void {
  for (const a of thermalAssemblies(ctx.doc)) {
    if (a.framing !== undefined && !a.layers.some((l) => l.function === 'core'))
      ctx.report('FS-THRM-LINT-001', `${a.id}'s framing has no core layer to interrupt.`, [a.id]);
    if (deriveAssembly(ctx.doc, a.layers).clear.resistance === null)
      ctx.report('FS-THRM-LINT-002', `${a.id} has a layer whose thermal resistance is not known.`, [a.id]);
  }
}

function derive(ctx: ExtensionContext): DerivedThermal {
  const all = thermalAssemblies(ctx.doc);
  const of = (s: ThermalAssembly['section']) => record(all.filter((a) => a.section === s).map((a): [string, DerivedAssembly] => [a.id, deriveAssembly(ctx.doc, a.layers, a.framing)]));
  return { wallTypes: of('wallTypes'), roofs: of('roofs'), floors: of('floors') };
}

export const FS_THERMAL: ExtensionImplementation<DerivedThermal> = {
  name: NAME,
  version: '0.1.0',
  code: 'THRM',
  catalogue: [
    { code: 'FS-THRM-SCH-001', severity: 'error', condition: 'the top-level data, or the data on an element, does not match the schema, or an element that may not carry FS_thermal data does' },
    { code: 'FS-THRM-INV-001', severity: 'error', condition: "a material's data has both a `conductivity` and a `resistance`" },
    { code: 'FS-THRM-INV-002', severity: 'error', condition: "a framing's `material`, or a layer's `material` in FS_thermal's data, names no material of the document" },
    { code: 'FS-THRM-LINT-001', severity: 'warning', condition: 'an assembly with a framing has no `core` layer (2.2)' },
    { code: 'FS-THRM-LINT-002', severity: 'info', condition: "an assembly's clear path has a resistance that is not known (3.1)" },
  ],
  validate,
  invariants,
  lints,
  derive,
};
