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
import { COLLECTIONS, WorkingCopy } from './model/working.js';
import { normalize } from './normalize.js';
import type { Ctx } from './references/resolve.js';
import { checkRequest } from './request.js';
import type { ApplyRequest, ApplyResult, ResolvedPrimitive, ResolveResult } from './types.js';
import { clone, cmpStr, isObject, type JsonObject } from './lib/json.js';

export type JsonInput = string | Uint8Array | object;

/** Parse a request given as JSON text or bytes; FS-OPS-001 when it is not a JSON text. */
function readRequest(input: JsonInput): ApplyRequest {
  if (typeof input === 'string' || input instanceof Uint8Array) {
    const parsed = parseJson(input);
    if (parsed.diagnostics.length || !('value' in parsed))
      throw new OpsFailure([opsDiagnostic('FS-OPS-001', `the request is not a JSON text: ${parsed.diagnostics.map((d) => d.message).join('; ')}`, [], '')]);
    return checkRequest(parsed.value, new Set(parsed.nonIntegerLiterals.map((p) => pointer(p))));
  }
  return checkRequest(input);
}

/**
 * Ops 0.1 applies to Floorspec Core 0.1 documents: the engine reads as a Core 0.1 reader here until
 * Ops 0.2 is ported (a document declaring "0.2" is FS-DOC-001, so FS-OPS-002).
 */
const CORE = { core: '0.1' } as const;

/** Step 1: A must be a valid Floorspec Core document (FS-OPS-002). Returns its parsed value. */
function readDocument(input: JsonInput): JsonObject {
  const ev = evaluate(input, CORE);
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

function prepare(document: JsonInput, request: JsonInput): Prepared {
  const req = readRequest(request);
  const a = readDocument(document);
  const wc = new WorkingCopy(clone(a), req.context?.retired ?? []);
  const locks = req.context?.locks ?? [];
  const bad = invalidLocks(new WorkingCopy(a, []), locks);
  if (bad.length) throw new OpsFailure(bad);
  return { request: req, a, wc, ctx: { wc, faces: new FacesCache(wc) } };
}

/** Steps 2–4 for the whole batch: the resolved primitives, per operation. */
function run(p: Prepared): { index: number; op: string; primitives: ResolvedPrimitive[] }[] {
  return p.request.batch.map((op, index) => ({ index, op: op.op, primitives: runOperation(p.ctx, op, index) }));
}

const elementIds = (doc: JsonObject): Set<string> => {
  const out = new Set<string>();
  for (const c of COLLECTIONS) {
    const coll = doc[c];
    if (isObject(coll)) for (const id of Object.keys(coll)) out.add(id);
  }
  return out;
};

/** A rejection, its diagnostics sorted by code and then by elements (Core §10.2). */
const rejected = (diagnostics: Diagnostic[]): ApplyResult => ({ status: 'rejected', diagnostics: sortDiagnostics([...diagnostics]) });

/**
 * Apply a batch to a document (Floorspec Ops 0.1, 1.2): `apply(A, { batch, context? })`.
 *
 * The document and the request may be JSON texts (strings or UTF-8 bytes) or parsed values. The
 * result is committed — B in canonical form, its hash, the resolved echo, what was created and
 * removed, and the inverse — or rejected with diagnostics, and A is never changed either way.
 */
export function apply(document: JsonInput, request: JsonInput): ApplyResult {
  try {
    const p = prepare(document, request);
    const resolved = run(p).flatMap((r) => r.primitives);
    // Step 5: normalize, once.
    const straddles = normalize(p.wc);
    if (straddles.length) return rejected(straddles);
    // Step 6: validate (Core tiers 3 and 4), then the locks in force.
    const ev = evaluate(p.wc.doc, CORE);
    if (!ev.valid) return rejected(ev.diagnostics.filter((d) => d.severity === 'error'));
    const aCanon = omitDefaults(p.a) as JsonObject;
    const bCanon = omitDefaults(p.wc.doc) as JsonObject;
    const broken = brokenLocks(new WorkingCopy(p.a, []), p.wc, aCanon, bCanon, p.request.context?.locks ?? []);
    if (broken.length) return rejected(broken);
    const before = elementIds(p.a);
    const after = elementIds(p.wc.doc);
    return {
      status: 'committed',
      document: canonicalize(p.wc.doc),
      hash: contentHash(p.wc.doc),
      resolved,
      created: [...after].filter((id) => !before.has(id)).sort(cmpStr),
      removed: [...before].filter((id) => !after.has(id)).sort(cmpStr),
      inverse: inverseOf(aCanon, bCanon),
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
export function resolveBatch(document: JsonInput, request: JsonInput): ResolveResult {
  try {
    const p = prepare(document, request);
    const operations = run(p);
    return { status: 'resolved', resolved: operations.flatMap((o) => o.primitives), operations };
  } catch (e) {
    if (e instanceof OpsFailure) return { status: 'rejected', diagnostics: sortDiagnostics([...e.diagnostics]) };
    throw e;
  }
}
