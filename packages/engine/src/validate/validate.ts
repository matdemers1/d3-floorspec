/**
 * The validator (10.1): parse → document → schema → invariants → lints, each tier evaluated only
 * when every earlier tier reported no error (10.3).
 */
import { validate as schema01 } from '../generated/validate-0.1.js';
import { validate as schema02 } from '../generated/validate-0.2.js';
import { validate as schema03 } from '../generated/validate-0.3.js';
import { parseJson } from '../json/parse.js';
import type { JsonPath } from '../json/pointer.js';
import type { FloorspecDocument } from '../model/document.js';
import { sortDiagnostics, type Diagnostic } from './diagnostic.js';
import { invariants, Reporter, type Analysis } from './invariants.js';
import { lints } from './lints.js';
import { loadKnownExtensions } from './registry.js';
import { evaluateExtensions, implementationsOf, lintExtensions, type ExtensionRun } from '../extensions/official.js';

/** The Floorspec Core versions this reader implements (1.2.2): Core 0.3, which also reads 0.1 and 0.2 (1.2.6). */
export const IMPLEMENTED_VERSIONS: readonly string[] = ['0.1', '0.2', '0.3'];

/** The Core drafts a reader configured as each draft implements: a reader of a draft reads every earlier one. */
const READS: Record<'0.1' | '0.2' | '0.3', readonly string[]> = { '0.1': ['0.1'], '0.2': ['0.1', '0.2'], '0.3': IMPLEMENTED_VERSIONS };

export interface ValidateOptions {
  /**
   * Extensions this reader implements (1.6.4): none by default — a core-only reader. Naming an
   * official extension the engine implements (`OFFICIAL_EXTENSION_NAMES`: FS_electrical,
   * FS_plumbing, FS_mechanical, FS_lowvoltage) also evaluates it, for a document that uses it at a
   * version the validator knows (`knownExtensions`; `OFFICIAL_EXTENSIONS` holds their entries), and
   * adds `extensions` to the derived values.
   */
  readonly extensions?: readonly string[];
  /**
   * The newest Core draft the reader implements. `'0.3'`, the default, reads documents declaring
   * "0.1", "0.2" or "0.3" (1.2.6) and derives chapters 11–13 and clear openings (7.4); `'0.2'` is a
   * Core 0.2 reader, which rejects "0.3" with FS-DOC-001, and `'0.1'` a Core 0.1 reader, which
   * rejects "0.2" too — what the published Core 0.2 and 0.1 suites test.
   */
  readonly core?: '0.1' | '0.2' | '0.3';
  /**
   * The validator's known extensions (12.2): a JSON array of registry entries, as text, UTF-8
   * bytes or a parsed value. Absent: none, and nothing defined in terms of known extensions is
   * checked. Known extensions that break 12.2.1 make every document report FS-CFG-001 alone.
   */
  readonly knownExtensions?: string | Uint8Array | readonly unknown[];
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
  /**
   * The official extensions evaluated for a valid document (each extension's spec, 1.2) — present,
   * possibly empty, whenever the reader implements one; the deriver derives `extensions` from it.
   */
  extensions?: ExtensionRun[];
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
  const versions = READS[options.core ?? '0.3'];
  // Tier 0: configuration — the known extensions must be a valid registry (12.2.2).
  let known: ReturnType<typeof loadKnownExtensions>;
  if (options.knownExtensions !== undefined && versions.includes('0.2')) {
    known = loadKnownExtensions(options.knownExtensions);
    if (!known) {
      r.report('FS-CFG-001', 'The known extensions this validator is configured with are not a valid registry (12.2.1).', []);
      return finish(r);
    }
  }

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
    if (typeof v === 'string' && !versions.includes(v))
      r.report('FS-DOC-001', `The document declares Floorspec ${v}; this reader implements ${versions.join(', ')}.`, [], { pointer: '/floorspec' });
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

  // Tier 3: schema — of the draft the document declares (1.2.6); of the newest draft the reader
  // implements when it declares none it can read.
  const declared = isObject(value) ? value.floorspec : undefined;
  const draft = typeof declared === 'string' && versions.includes(declared) ? declared : versions[versions.length - 1];
  const fn = (draft === '0.1' ? schema01 : draft === '0.2' ? schema02 : schema03) as unknown as SchemaFn;
  if (!fn(schemaView(value, nonInteger))) {
    for (const e of fn.errors ?? [])
      r.report('FS-SCH-001', `${e.instancePath || '/'}: ${e.message ?? e.keyword}`, [], { pointer: e.instancePath });
    if (!r.diagnostics.length) r.report('FS-SCH-001', 'The document does not match the schema.', []);
    return finish(r, { value });
  }
  const document = value as FloorspecDocument;

  // Tier 4: invariants.
  const analysis = invariants(document, r, { core02: versions.includes('0.2'), ...(known && { known }) });
  if (!analysis) return finish(r, { value, document });

  // The extensions this reader implements, after Core's invariants and only without a Core error:
  // their schemas, then their invariants (each extension's spec, 1.2).
  const implemented = implementationsOf(options.extensions);
  let runs: ExtensionRun[] | undefined;
  if (implemented.length) {
    runs = [];
    if (!r.diagnostics.some((d) => d.severity === 'error'))
      runs = evaluateExtensions(document, analysis, known, implemented, schemaView(value, nonInteger), r.diagnostics);
  }

  // Tier 5: lints, only for a valid document — Core's, then the extensions'.
  if (!r.diagnostics.some((d) => d.severity === 'error')) {
    lints(document, analysis, r);
    if (runs) lintExtensions(runs);
  }
  return finish(r, { value, document, analysis, ...(runs && { extensions: runs }) });
}

/** Validate a document (chapter 10): `{ valid, diagnostics }`. */
export function validate(input: string | Uint8Array | object, options: ValidateOptions = {}): ValidationResult {
  const { valid, diagnostics } = evaluate(input, options);
  return { valid, diagnostics };
}
