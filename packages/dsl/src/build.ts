/**
 * Compile, apply with `@floorspec/ops`, and check with `@floorspec/engine`: the document a DSL text
 * describes. An error the applier or the engine reports is placed on the line that made the
 * operation (`/batch/<n>/…`) or the element it names.
 */
import { check, parseJson, type Diagnostic } from '@floorspec/engine';
import { apply } from '@floorspec/ops';
import { compile, type Compiled, type CompileOptions } from './compile.js';
import type { DslDiagnostic, Pos } from './diagnostics.js';

export interface Built {
  readonly ok: true;
  /** The document, in its canonical form (Core §9.2). */
  readonly document: string;
  /** Its content hash (Core §9.3). */
  readonly hash: string;
  readonly compiled: Compiled;
  readonly warnings: DslDiagnostic[];
}

export type BuildResult = Built | { readonly ok: false; readonly diagnostics: DslDiagnostic[] };

const EMPTY = (): Record<string, unknown> => ({ floorspec: '0.3', project: { name: 'Untitled' } });

/** Place an Ops or Core diagnostic on a line of the text. */
function locate(d: Diagnostic, compiled: Compiled): DslDiagnostic {
  let pos: Pos | undefined;
  const m = /^\/batch\/([0-9]+)/.exec(d.location.pointer ?? '');
  if (m) pos = compiled.sources[Number(m[1])];
  for (const id of d.elements) {
    if (pos) break;
    pos = compiled.elements.get(id);
  }
  pos ??= { line: 1, column: 1 };
  return { code: d.code, severity: d.severity === 'error' ? 'error' : 'warning', message: d.message, line: pos.line, column: pos.column };
}

/** The document a DSL text describes, applied to `base` (default: an empty Core 0.3 document). */
export function build(text: string, options: CompileOptions = {}): BuildResult {
  const compiled = compile(text, options);
  if (!compiled.ok) return compiled;
  const base: unknown = options.base === undefined ? EMPTY() : typeof options.base === 'string' || options.base instanceof Uint8Array ? parseJson(options.base).value : options.base;
  if (compiled.batch.length === 0) {
    // Nothing to apply: the document is the base, as it is.
    const c = check(base as object);
    if (!c.valid) return { ok: false, diagnostics: c.diagnostics.filter((d) => d.severity === 'error').map((d) => locate(d, compiled)) };
    return { ok: true, document: c.canonical!, hash: c.hash!, compiled, warnings: compiled.warnings };
  }
  const r = apply(base as object, { batch: compiled.batch });
  if (r.status !== 'committed') return { ok: false, diagnostics: r.diagnostics.map((d) => locate(d, compiled)) };
  const checked = check(r.document);
  if (!checked.valid) return { ok: false, diagnostics: checked.diagnostics.filter((d) => d.severity === 'error').map((d) => locate(d, compiled)) };
  return { ok: true, document: r.document, hash: r.hash, compiled, warnings: compiled.warnings };
}
