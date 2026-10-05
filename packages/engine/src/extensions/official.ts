/**
 * The official extensions the engine implements — FS_electrical, FS_plumbing, FS_mechanical and
 * FS_lowvoltage 0.1.0 — and the extension tier of validation (each extension's spec, 1.2).
 *
 * An extension is **evaluated** for a document when the reader implements it (its name is in
 * `ValidateOptions.extensions`), the document declares "0.2" and uses it at a version equal to the
 * implemented one, and the validator knows it at that version (`knownExtensions`, Core 12.2). Its
 * schema is checked (FS-<CODE>-SCH-001) and, when that passes, its invariants — after Core's
 * invariants, and only when Core reported no error; its lints only for a valid document; and what
 * it derives becomes `derived.extensions[name]`.
 */
import { OFFICIAL_ENTRIES } from '../generated/official-extensions.js';
import { declaredVersion, type FloorspecDocument, type RegistryEntry } from '../model/document.js';
import type { Analysis } from '../validate/invariants.js';
import type { Diagnostic } from '../validate/diagnostic.js';
import { compareVersions, knownEntry } from '../validate/registry.js';
import { ExtensionContext, type ExtensionImplementation } from './context.js';
import { FS_ELECTRICAL, type DerivedElectrical } from './fs/electrical.js';
import { FS_LOWVOLTAGE, type DerivedLowVoltage } from './fs/lowvoltage.js';
import { FS_MECHANICAL, type DerivedMechanical } from './fs/mechanical.js';
import { FS_PLUMBING, type DerivedPlumbing } from './fs/plumbing.js';

/**
 * The official extensions' registry entries (registry/<NAME>/extension.json, vendored), ready to
 * pass as `knownExtensions`: `validate(doc, { extensions: OFFICIAL_EXTENSION_NAMES, knownExtensions: OFFICIAL_EXTENSIONS })`.
 */
export const OFFICIAL_EXTENSIONS: readonly RegistryEntry[] = OFFICIAL_ENTRIES as unknown as RegistryEntry[];

/** Every extension implementation the engine has, by name. */
export const IMPLEMENTATIONS: ReadonlyMap<string, ExtensionImplementation> = new Map(
  ([FS_ELECTRICAL, FS_PLUMBING, FS_MECHANICAL, FS_LOWVOLTAGE] as ExtensionImplementation[]).map((x) => [x.name, x]),
);

/** The names of the official extensions the engine implements. */
export const OFFICIAL_EXTENSION_NAMES: readonly string[] = [...IMPLEMENTATIONS.keys()];

/** What the official extensions derive, by name: `derived.extensions`. */
export interface DerivedExtensions {
  FS_electrical?: DerivedElectrical;
  FS_plumbing?: DerivedPlumbing;
  FS_mechanical?: DerivedMechanical;
  FS_lowvoltage?: DerivedLowVoltage;
}

/** One evaluated extension: its implementation and its data, ready for lints and derivation. */
export interface ExtensionRun {
  readonly impl: ExtensionImplementation;
  readonly ctx: ExtensionContext;
}

/** The implementations a reader that implements `names` has. */
export function implementationsOf(names: readonly string[] | undefined): ExtensionImplementation[] {
  return (names ?? []).flatMap((n) => IMPLEMENTATIONS.get(n) ?? []);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The extension tier, for a document Core found no error in: each evaluated extension's schema,
 * then its invariants. `schemaView` is the document as the schema sees it (a number written with a
 * fraction or an exponent is NaN, 10.1). Returns the extensions whose data matched their schema.
 */
export function evaluateExtensions(
  doc: FloorspecDocument,
  analysis: Analysis,
  known: readonly RegistryEntry[] | undefined,
  implemented: readonly ExtensionImplementation[],
  schemaView: unknown,
  out: Diagnostic[],
): ExtensionRun[] {
  if (doc.floorspec !== '0.2') return [];
  const runs: ExtensionRun[] = [];
  const used = (doc.extensionsUsed ?? {}) as Record<string, Parameters<typeof declaredVersion>[0]>;
  for (const impl of [...implemented].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!Object.hasOwn(used, impl.name)) continue;
    const version = declaredVersion(used[impl.name]!);
    if (!knownEntry(known, impl.name, version) || compareVersions(version, impl.version) !== 0) continue;
    const ctx = new ExtensionContext(doc, analysis, impl, out);
    const exts = isObject(schemaView) ? (schemaView as { extensions?: unknown }).extensions : undefined;
    const data = isObject(exts) && Object.hasOwn(exts, impl.name) ? exts[impl.name] : {};
    if (!impl.validate(data)) {
      ctx.report(`FS-${impl.code}-SCH-001`, `The ${impl.name} data does not match the ${impl.name} ${impl.version} schema.`, [], `/extensions/${impl.name}`);
      continue;
    }
    impl.invariants(ctx);
    runs.push({ impl, ctx });
  }
  return runs;
}

/** The evaluated extensions' lints, for a valid document. */
export function lintExtensions(runs: readonly ExtensionRun[]): void {
  for (const run of runs) run.impl.lints(run.ctx);
}

/** What the evaluated extensions derive, for a valid document. */
export function deriveExtensions(runs: readonly ExtensionRun[]): DerivedExtensions {
  const out: Record<string, unknown> = {};
  for (const run of runs) Object.defineProperty(out, run.impl.name, { value: run.impl.derive(run.ctx), enumerable: true, writable: true, configurable: true });
  return out;
}
