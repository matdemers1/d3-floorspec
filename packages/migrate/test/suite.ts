/** Reading the vendored suites: test directories, and a diagnostic as expected.json holds it. */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Diagnostic } from '@floorspec/engine';

export const STANDARD = join(import.meta.dirname, '..', 'standard');
/** The engine's vendored Core suites: the documents of every earlier draft (packages/engine/standard). */
export const CORE_SUITES = join(import.meta.dirname, '..', '..', 'engine', 'standard', 'conformance', 'core');

export function cases(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...cases(p));
    else if (entry === 'test.json') out.push(dir);
  }
  return out;
}

export const view = (d: Diagnostic) => ({ code: d.code, severity: d.severity, elements: d.elements, ...(d.design !== undefined && { design: d.design }) });

/** Diagnostics compared as conformance/README.md says: one or more FS-SCH-001 match an expected [FS-SCH-001]. */
export function diagnosticsView(ds: readonly Diagnostic[]): ReturnType<typeof view>[] {
  const v = ds.map(view);
  return v.length && v.every((d) => d.code === 'FS-SCH-001') ? [v[0]!] : v;
}
