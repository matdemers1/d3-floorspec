/**
 * The validator (10.1): parse → document → schema → invariants → lints, each tier evaluated only
 * when every earlier tier reported no error (10.3).
 */
import { validate as schemaValidate } from '../generated/validate.js';
import { parseJson } from '../json/parse.js';
import type { JsonPath } from '../json/pointer.js';
import type { FloorspecDocument } from '../model/document.js';
import { sortDiagnostics, type Diagnostic } from './diagnostic.js';
import { invariants, Reporter, type Analysis } from './invariants.js';
import { lints } from './lints.js';

/** The Floorspec Core versions this reader implements (1.2.2). */
export const IMPLEMENTED_VERSIONS: readonly string[] = ['0.1'];

export interface ValidateOptions {
  /** Extensions this reader implements (1.6.4). Core 0.1 defines none, and the engine implements none. */
  readonly extensions?: readonly string[];
}

export interface ValidationResult {
  /** True iff no diagnostic has severity `error` (10.1.1). */
  valid: boolean;
  /** Every diagnostic, sorted by code and then by elements (10.2). */
  diagnostics: Diagnostic[];
}

/** The validator's working state, kept for the deriver: the parsed document and its geometry. */
export interface Evaluation extends ValidationResult {
  /** The parsed document, when it parsed. */
  value?: unknown;
  /** The document, when it passed the schema tier. */
  document?: FloorspecDocument;
  /** Level geometry, when the reference invariants held. */
  analysis?: Analysis;
}

type SchemaError = { instancePath: string; message?: string; keyword: string };
type SchemaFn = ((data: unknown) => boolean) & { errors?: SchemaError[] | null };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The document as the schema sees it (10.1): every number written with a fraction or an exponent
 * replaced by NaN, which no `integer` or `number` keyword accepts, and which `extras` and extension
 * data accept as they accept any JSON.
 */
function schemaView(value: unknown, nonInteger: readonly JsonPath[]): unknown {
  if (nonInteger.length === 0) return value;
  const root = structuredClone(value);
  for (const path of nonInteger) {
    if (path.length === 0) return Number.NaN;
    let node: unknown = root;
    for (const k of path.slice(0, -1)) node = (node as Record<string | number, unknown>)[k];
    const last = path[path.length - 1]!;
    Object.defineProperty(node, last, { value: Number.NaN, enumerable: true, writable: true, configurable: true });
  }
  return root;
}

function finish(r: Reporter, extra: Omit<Evaluation, 'valid' | 'diagnostics'> = {}): Evaluation {
  const diagnostics = sortDiagnostics(r.diagnostics);
  return { valid: !diagnostics.some((d) => d.severity === 'error'), diagnostics, ...extra };
}

/**
 * Validate a document, given as a JSON text (UTF-8 bytes or a string) or as an already-parsed
 * value, and keep what the deriver needs.
 */
export function evaluate(input: string | Uint8Array | object, options: ValidateOptions = {}): Evaluation {
  const r = new Reporter();
  // Tier 1: parsing.
  let value: unknown;
  let nonInteger: readonly JsonPath[] = [];
  if (typeof input === 'string' || input instanceof Uint8Array) {
    const parsed = parseJson(input);
    r.diagnostics.push(...parsed.diagnostics);
    if (parsed.diagnostics.length) return finish(r, 'value' in parsed ? { value: parsed.value } : {});
    value = parsed.value;
    nonInteger = parsed.nonIntegerLiterals;
  } else {
    value = input;
  }

  // Tier 2: document — can this reader read it at all?
  if (isObject(value)) {
    const v = value.floorspec;
    if (typeof v === 'string' && !IMPLEMENTED_VERSIONS.includes(v))
      r.report('FS-DOC-001', `The document declares Floorspec ${v}; this reader implements ${IMPLEMENTED_VERSIONS.join(', ')}.`, [], { pointer: '/floorspec' });
    // FS-DOC-002 only for a well-formed extensionsRequired — an array of distinct names, each a
    // member of extensionsUsed (an object); any other is left to the schema tier and FS-INV-004.
    const req = value.extensionsRequired;
    const used = value.extensionsUsed;
    const implemented = options.extensions ?? [];
    if (
      Array.isArray(req) &&
      isObject(used) &&
      req.every((n) => typeof n === 'string' && Object.hasOwn(used, n)) &&
      new Set(req).size === req.length
    )
      (req as string[]).forEach((name, i) => {
        if (!implemented.includes(name))
          r.report('FS-DOC-002', `The document requires the extension ${name}, which this reader does not implement.`, [], { pointer: `/extensionsRequired/${i}` });
      });
    if (r.diagnostics.length) return finish(r, { value });
  }

  // Tier 3: schema.
  const fn = schemaValidate as unknown as SchemaFn;
  if (!fn(schemaView(value, nonInteger))) {
    for (const e of fn.errors ?? [])
      r.report('FS-SCH-001', `${e.instancePath || '/'}: ${e.message ?? e.keyword}`, [], { pointer: e.instancePath });
    if (!r.diagnostics.length) r.report('FS-SCH-001', 'The document does not match the schema.', []);
    return finish(r, { value });
  }
  const document = value as FloorspecDocument;

  // Tier 4: invariants.
  const analysis = invariants(document, r);
  if (!analysis) return finish(r, { value, document });

  // Tier 5: lints, only for a valid document.
  if (!r.diagnostics.some((d) => d.severity === 'error')) lints(document, analysis, r);
  return finish(r, { value, document, analysis });
}

/** Validate a document (chapter 10): `{ valid, diagnostics }`. */
export function validate(input: string | Uint8Array | object, options: ValidateOptions = {}): ValidationResult {
  const { valid, diagnostics } = evaluate(input, options);
  return { valid, diagnostics };
}
