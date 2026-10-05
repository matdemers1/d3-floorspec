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
import { designInvariants, referenceTier, Reporter, type Analysis, type InvariantOptions } from './invariants.js';
import { documentLints, lints } from './lints.js';
import { references } from './references.js';
import { checkedDesigns, checkedTagOf, hasOptions, mergeDesigns, optionInvariants, primaryDesign, resolveDesign, singleOptionSets, viewOf, type CheckedDesign, type Design } from '../options/options.js';
import type { Package } from '../finishes/finishes.js';
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
  /**
   * Core 0.3 (19.6): the design to derive — a design input, an object of option set ID → option ID,
   * every set it does not name taking its primary. Absent: the primary design. Validity never
   * depends on it; nothing is derived for a design that is not one of the document's, or whose view
   * is not valid (19.6.2).
   */
  readonly design?: unknown;
  /**
   * Core 0.3 (18.4): the files of the document's package, which makes this a package validator —
   * every asset located by `path` is checked against its file (FS-INV-1005 to FS-INV-1007).
   * Absent: a validator that is not given them, which never reports those three.
   */
  readonly package?: Package;
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
  /**
   * The document as seen in the derived design (19.3) — what `analysis` and `extensions` are of: the
   * document itself when it has no design options. Absent when nothing is derived.
   */
  view?: FloorspecDocument;
  /**
   * Core 0.3 (19.6): for a valid document with design options, the design derived (every set's
   * choice), or null when the design input names no design of the document or its view is not valid
   * (19.6.2) — then nothing is derived. Absent for a document without design options.
   */
  design?: Design | null;
  /** For a valid document with design options: every checked design (19.5), the primary design first, with its view and analysis. */
  designs?: CheckedDesignEvaluation[];
}

/** One checked design of a valid document with design options: its tag (undefined for the primary design, else its option), view and analysis. */
export interface CheckedDesignEvaluation extends CheckedDesign {
  readonly document: FloorspecDocument;
  readonly analysis: Analysis;
  readonly extensions?: ExtensionRun[];
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

  // Tier 4: invariants — the reference invariants and, with design options, the option invariants
  // of the document as a whole; then the rest of tier 4 for the view of each checked design (19.5),
  // a document without design options being its own only one.
  if (!referenceTier(document, r)) return finish(r, { value, document });
  const optioned = versions.includes('0.3') && hasOptions(document);
  if (optioned) {
    for (const p of optionInvariants(document, references(document)))
      r.report(
        p.code,
        p.code === 'FS-INV-1101'
          ? `${p.elements[0]}'s primary ${p.elements[1]} is an option of another set.`
          : `${p.elements[0]} and ${p.elements[1]} are not in the same option, and one refers to the other, which is in an option.`,
        p.elements,
        p.pointer ? { pointer: p.pointer } : {},
      );
    if (r.diagnostics.length) return finish(r, { value, document });
  }
  const opts: InvariantOptions = {
    core02: versions.includes('0.2'),
    core03: versions.includes('0.3'),
    ...(known && { known }),
    ...(options.package && { package: options.package }),
  };
  const sv = schemaView(value, nonInteger);
  const designs: DesignRun[] = (optioned ? checkedDesigns(document) : [{ tag: undefined, design: {} }]).map(({ tag, design }) => {
    const view = optioned ? viewOf(document, design) : document;
    const dr = new Reporter();
    const analysis = designInvariants(view, dr, opts);
    return { tag, design, view, analysis, schemaView: optioned ? viewOf(sv, design) : sv, invariants: dr.diagnostics };
  });
  r.diagnostics.push(...mergeDesigns(designs.map((d) => ({ tag: d.tag, diagnostics: d.invariants }))));
  const primary = designs[0]!;
  const keep = { value, document, view: primary.view, analysis: primary.analysis };
  if (hasError(r)) return finish(r, keep);

  // The extensions this reader implements, after Core's invariants and only without a Core error:
  // their schemas, then their invariants (each extension's spec, 1.2) — for each checked design.
  const implemented = implementationsOf(options.extensions);
  if (implemented.length) {
    for (const d of designs) {
      d.extensionOut = [];
      d.runs = evaluateExtensions(d.view, d.analysis, known, implemented, d.schemaView, d.extensionOut);
    }
    r.diagnostics.push(...mergeDesigns(designs.map((d) => ({ tag: d.tag, diagnostics: d.extensionOut! }))));
    if (hasError(r)) return finish(r, { ...keep, extensions: primary.runs! });
  }

  // Tier 5: lints, only for a valid document — Core's, then the extensions', of each checked design;
  // FS-LINT-006, FS-LINT-007 and FS-LINT-017 of the document as a whole.
  r.diagnostics.push(
    ...mergeDesigns(
      designs.map((d) => {
        const lr = new Reporter();
        lints(d.view, d.analysis, lr);
        if (d.runs) {
          const before = d.extensionOut!.length;
          lintExtensions(d.runs);
          lr.diagnostics.push(...d.extensionOut!.slice(before));
        }
        return { tag: d.tag, diagnostics: lr.diagnostics };
      }),
    ),
  );
  documentLints(document, r);
  if (optioned) for (const sid of singleOptionSets(document)) r.report('FS-LINT-017', `${sid} has one option, so there is nothing to choose between.`, [sid], { pointer: `/optionSets/${sid}` });

  // The design derived (19.6): the primary design without a design input.
  const chosen = resolveRequested(document, optioned, options.design);
  const designsOut = optioned ? designs.map((d) => ({ tag: d.tag, design: d.design, document: d.view, analysis: d.analysis, ...(d.runs && { extensions: d.runs }) })) : undefined;
  const base = { value, document, ...(designsOut && { designs: designsOut }) };
  if (chosen === undefined) return finish(r, { ...base, design: null });
  if (!optioned) return finish(r, { ...base, view: document, analysis: primary.analysis, ...(primary.runs && { extensions: primary.runs }) });
  const tagged = checkedTagOf(document, chosen);
  const found = tagged && designs.find((d) => d.tag === tagged.tag);
  if (found) return finish(r, { ...base, design: chosen, view: found.view, analysis: found.analysis, ...(found.runs && { extensions: found.runs }) });
  // A design that is not a checked one: derived only when its view is valid (19.6.2).
  const view = viewOf(document, chosen);
  const dr = new Reporter();
  const analysis = designInvariants(view, dr, opts);
  if (hasError(dr)) return finish(r, { ...base, design: null });
  let runs: ExtensionRun[] | undefined;
  if (implemented.length) {
    const out: Diagnostic[] = [];
    runs = evaluateExtensions(view, analysis, known, implemented, viewOf(sv, chosen), out);
    if (out.some((d) => d.severity === 'error')) return finish(r, { ...base, design: null });
  }
  return finish(r, { ...base, design: chosen, view, analysis, ...(runs && { extensions: runs }) });
}

/** One checked design's evaluation in progress. */
interface DesignRun {
  readonly tag: string | undefined;
  readonly design: Design;
  readonly view: FloorspecDocument;
  readonly analysis: Analysis;
  readonly schemaView: unknown;
  readonly invariants: Diagnostic[];
  extensionOut?: Diagnostic[];
  runs?: ExtensionRun[];
}

const hasError = (r: { diagnostics: readonly Diagnostic[] }): boolean => r.diagnostics.some((d) => d.severity === 'error');

/**
 * The design a design input asks for (19.6): the primary design without one; undefined when it names
 * an option set the document does not have or maps a set to an option that is not that set's — and,
 * for a document without design options, when it is anything but `{}`.
 */
function resolveRequested(document: FloorspecDocument, optioned: boolean, input: unknown): Design | undefined {
  if (!optioned) return input === undefined || (isObject(input) && Object.keys(input).length === 0) ? {} : undefined;
  return input === undefined ? primaryDesign(document) : resolveDesign(document, input);
}

/** Validate a document (chapter 10): `{ valid, diagnostics }`. */
export function validate(input: string | Uint8Array | object, options: ValidateOptions = {}): ValidationResult {
  const { valid, diagnostics } = evaluate(input, options);
  return { valid, diagnostics };
}
