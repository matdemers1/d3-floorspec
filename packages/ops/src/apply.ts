/**
 * The transaction (1.2): check A, then resolve, expand and apply operation by operation, normalize
 * once, validate and check locks once, and commit B — or reject the whole batch with the
 * diagnostics of the first step that failed, leaving the document exactly A.
 *
 * Deterministic by construction (1.3.2): no clock, no randomness, no floating point. Lengths are
 * BigInt or exact rationals until they are rounded once; geometry uses the engine's exact Surd
 * arithmetic and integer predicates; IDs and members are ordered by UTF-16 code units.
 */
import { canonicalize, contentHash, evaluate, omitDefaults, parseJson, pointer, sortDiagnostics, type Diagnostic } from '@floorspec/engine';
import { OpsFailure, opsDiagnostic } from './diagnostics.js';
import { runOperation } from './expand.js';
import { inverseOf } from './inverse.js';
import { brokenLocks, invalidLocks } from './locks.js';
import { FacesCache } from './model/faces.js';
import { atLeast03, idsOf, WorkingCopy, type OpsVersion } from './model/working.js';
import { normalize } from './normalize.js';
import type { Ctx } from './references/resolve.js';
import { checkRequest } from './request.js';
import type { ApplyOptions, ApplyRequest, ApplyResult, ResolvedPrimitive, ResolveResult } from './types.js';
import { clone, cmpStr, type JsonObject } from './lib/json.js';

export type JsonInput = string | Uint8Array | object;

/** Parse a request given as JSON text or bytes; FS-OPS-001 when it is not a JSON text. */
function readRequest(input: JsonInput, ops: OpsVersion): ApplyRequest {
  if (typeof input === 'string' || input instanceof Uint8Array) {
    const parsed = parseJson(input);
    if (parsed.diagnostics.length || !('value' in parsed))
      throw new OpsFailure([opsDiagnostic('FS-OPS-001', `the request is not a JSON text: ${parsed.diagnostics.map((d) => d.message).join('; ')}`, [], '')]);
    return checkRequest(parsed.value, new Set(parsed.nonIntegerLiterals.map((p) => pointer(p))), ops);
  }
  return checkRequest(input, new Set(), ops);
}

/**
 * How A and the result are validated (0.2, 1.2 steps 1 and 6): Ops 0.1 applies to Core 0.1
 * documents, with a Core 0.1 reader (a document declaring "0.2" is FS-DOC-001, so FS-OPS-002); Ops
 * 0.2 with a Core 0.2 reader, which reads 0.1 documents too (and rejects "0.3" the same way); Ops
 * 0.3 with a Core 0.3 reader, which reads 0.2 and 0.1 documents too — each with the known and
 * implemented extensions it is given.
 */
interface Settings {
  readonly ops: OpsVersion;
  readonly core: { core: '0.1' | '0.2' | '0.3' | '0.4'; knownExtensions?: string | Uint8Array | readonly unknown[]; extensions?: readonly string[] };
}

function settings(options: ApplyOptions): Settings {
  const ops: string = options.ops ?? '0.4';
  if (ops !== '0.1' && ops !== '0.2' && ops !== '0.3' && ops !== '0.4') throw new RangeError(`@floorspec/ops applies Floorspec Ops 0.1, 0.2, 0.3 and 0.4, not ${ops}`);
  if (ops === '0.1') return { ops, core: { core: '0.1' } };
  return {
    ops,
    core: {
      core: ops,
      ...(options.knownExtensions === undefined ? {} : { knownExtensions: options.knownExtensions }),
      ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
    },
  };
}

/** Step 1: A must be a valid Floorspec Core document (FS-OPS-002). Returns its parsed value. */
function readDocument(input: JsonInput, s: Settings): JsonObject {
  const ev = evaluate(input, s.core);
  if (!ev.valid) {
    const codes = [...new Set(ev.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code))];
    throw new OpsFailure([opsDiagnostic('FS-OPS-002', `the document is not a valid Floorspec Core document (${codes.join(', ')})`, [], '')]);
  }
  const value = typeof input === 'string' || input instanceof Uint8Array ? ev.value : input;
  return clone(value as JsonObject);
}

interface Prepared {
  readonly request: ApplyRequest;
  readonly a: JsonObject;
  readonly wc: WorkingCopy;
  readonly ctx: Ctx;
}

function prepare(document: JsonInput, request: JsonInput, s: Settings): Prepared {
  const req = readRequest(request, s.ops);
  const a = readDocument(document, s);
  const wc = new WorkingCopy(clone(a), req.context?.retired ?? [], s.ops);
  if (atLeast03(s.ops)) wc.editOption = req.context?.option;
  const locks = req.context?.locks ?? [];
  const bad = invalidLocks(new WorkingCopy(a, [], s.ops), locks);
  if (bad.length) throw new OpsFailure(bad);
  return { request: req, a, wc, ctx: { wc, faces: new FacesCache(wc) } };
}

/** Steps 2–4 for the whole batch: the resolved primitives, per operation. */
function run(p: Prepared): { index: number; op: string; primitives: ResolvedPrimitive[] }[] {
  return p.request.batch.map((op, index) => ({ index, op: op.op, primitives: runOperation(p.ctx, op, index) }));
}

/** A rejection, its diagnostics sorted by code and then by elements (Core §10.2). */
const rejected = (diagnostics: Diagnostic[]): ApplyResult => ({ status: 'rejected', diagnostics: sortDiagnostics([...diagnostics]) });

/**
 * Apply a batch to a document (Floorspec Ops 1.2): `apply(A, { batch, context? }, { ops? })`.
 *
 * The document and the request may be JSON texts (strings or UTF-8 bytes) or parsed values. The
 * result is committed — B in canonical form, its hash, the resolved echo, what was created and
 * removed, and the inverse — or rejected with diagnostics, and A is never changed either way.
 * `options.ops` chooses the draft: Ops 0.3 by default, or Ops 0.2 or 0.1 exactly as published.
 */
export function apply(document: JsonInput, request: JsonInput, options: ApplyOptions = {}): ApplyResult {
  const s = settings(options);
  try {
    const p = prepare(document, request, s);
    const resolved = run(p).flatMap((r) => r.primitives);
    // Step 5: normalize, once.
    const straddles = normalize(p.wc);
    if (straddles.length) return rejected(straddles);
    // Step 6: validate (Core tiers 3 and 4), then the locks in force.
    const ev = evaluate(p.wc.doc, s.core);
    if (!ev.valid) return rejected(ev.diagnostics.filter((d) => d.severity === 'error'));
    const aCanon = omitDefaults(p.a) as JsonObject;
    const bCanon = omitDefaults(p.wc.doc) as JsonObject;
    const broken = brokenLocks(new WorkingCopy(p.a, [], s.ops), p.wc, aCanon, bCanon, p.request.context?.locks ?? [], p.wc.editOption);
    if (broken.length) return rejected(broken);
    const before = idsOf(p.a, s.ops);
    const after = idsOf(p.wc.doc, s.ops);
    return {
      status: 'committed',
      document: canonicalize(p.wc.doc),
      hash: contentHash(p.wc.doc),
      resolved,
      created: [...after].filter((id) => !before.has(id)).sort(cmpStr),
      removed: [...before].filter((id) => !after.has(id)).sort(cmpStr),
      inverse: inverseOf(aCanon, bCanon, s.ops),
    };
  } catch (e) {
    if (e instanceof OpsFailure) return rejected(e.diagnostics);
    throw e;
  }
}

/**
 * Resolve and expand a batch without committing it (for echoes and proposals): steps 1–4 of the
 * transaction, so references are resolved against the working copy each operation would see.
 * Normalization, validation and locks are not run; `apply` decides whether the batch commits.
 */
export function resolveBatch(document: JsonInput, request: JsonInput, options: ApplyOptions = {}): ResolveResult {
  const s = settings(options);
  try {
    const p = prepare(document, request, s);
    const operations = run(p);
    return { status: 'resolved', resolved: operations.flatMap((o) => o.primitives), operations };
  } catch (e) {
    if (e instanceof OpsFailure) return { status: 'rejected', diagnostics: sortDiagnostics([...e.diagnostics]) };
    throw e;
  }
}
