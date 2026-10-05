/**
 * The IFC round trip (FLR-T-9.5; FLR-REQ-132): an IFC file this project exported, edited in another
 * tool and brought back, reconciled by Floorspec ID against the version it came from.
 *
 * The api finds that version by the file's `DocumentHash` ({@link documentHashOf}), builds its
 * payload exactly as an export does ({@link ifcPayload}), and sends both to the Python IFC worker's
 * `POST /import`, which exports the payload again in-process, compares the two files element by
 * element and answers an Ops 0.3 batch — grouped into edits — and a report of every edit it could not
 * map. Nothing here touches a document: the api applies the batch as a proposed changeset.
 */
import { exportIfc, ifcPayload, ifcWorkerUrl, type IfcVersionFacts } from './index.js';

export { exportIfc, ifcPayload, ifcWorkerUrl, type IfcVersionFacts };

export const IFC_IMPORT_FORMAT = 'floorspec-ifc-import';
export const IFC_IMPORT_VERSION = 1;
export const IFC_RECONCILIATION_FORMAT = 'floorspec-ifc-reconciliation';

/** One operation of the batch: an object whose `op` names it (Ops 1.1). */
export interface IfcOp {
  readonly op: string;
  readonly [member: string]: unknown;
}

/** One element's changes, one junction move, one removal or one new wall: applied whole, or not. */
export interface IfcEdit {
  readonly element: string;
  readonly kind: string;
  /** What changed, for a person: "wall WW moved 300 mm west; WN1, WS2 follow". */
  readonly changes: readonly string[];
  readonly ops: readonly IfcOp[];
  /** The IFC entities it was read from. */
  readonly sources: readonly { readonly globalId: string; readonly entity: string }[];
}

/** An edit that was not imported, or something worth knowing about the file. */
export interface IfcReportEntry {
  /**
   * `unmapped`: an edit with no Floorspec equivalent; `ambiguous`: one the file says two ways;
   * `note`: nothing to do; `rejected` (added by the api): an edit the Ops applier refused.
   */
  readonly severity: 'unmapped' | 'ambiguous' | 'note' | 'rejected';
  readonly globalId: string | null;
  readonly entity: string | null;
  readonly element: string | null;
  readonly kind: string | null;
  readonly name: string | null;
  readonly change: string;
  readonly reason: string;
}

export interface IfcReconciliation {
  readonly format: typeof IFC_RECONCILIATION_FORMAT;
  readonly version: number;
  /** The version the file was reconciled against. */
  readonly base: string;
  /** The version the file says it came from (its IfcProject's DocumentHash). */
  readonly documentHash: string | null;
  readonly file: { readonly name?: string; readonly schema?: string; readonly originatingSystem?: string | null; readonly lengthUnitMm?: number };
  readonly batch: readonly IfcOp[];
  readonly edits: readonly IfcEdit[];
  readonly report: readonly IfcReportEntry[];
  readonly counts: Readonly<Record<string, number>>;
}

export interface IfcImportOptions {
  readonly version: IfcVersionFacts;
  /** The uploaded file's name, for the report. */
  readonly name: string;
  readonly workerUrl?: string;
  /** How long to wait for the reconciliation (ms). Default 120000. */
  readonly timeoutMs?: number;
}

/** The IFC worker could not be reached, or did not answer in time. */
export class IfcWorkerUnavailable extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'IfcWorkerUnavailable';
  }
}

/** The IFC worker read the request and refused it: the message is the worker's sentence. */
export class IfcImportRefused extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'IfcImportRefused';
  }
}

const DOCUMENT_HASH = /IFCPROPERTYSINGLEVALUE\(\s*'DocumentHash'\s*,\s*(?:\$|'[^']*')\s*,\s*IFCIDENTIFIER\(\s*'([0-9a-f]{64})'\s*\)/gi;

/**
 * The version an IFC file says it came from: the `DocumentHash` its elements' `Floorspec_Identity`
 * carry — the commonest, since every element of one export carries the same — and every distinct
 * one found. A scan of the STEP text, not a parse: the parse is the worker's.
 */
export function documentHashOf(bytes: Uint8Array): { hash: string | null; hashes: string[] } {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
  const counts = new Map<string, number>();
  for (const m of text.matchAll(DOCUMENT_HASH)) {
    const h = (m[1] as string).toLowerCase();
    counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  const hashes = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([h]) => h);
  return { hash: hashes[0] ?? null, hashes };
}

/** Reconcile an edited IFC file against the version it came from, through the IFC worker. */
export async function reconcileIfc(document: object, ifc: Uint8Array, options: IfcImportOptions): Promise<IfcReconciliation> {
  const payload = ifcPayload(document, options.version);
  const base = options.workerUrl ?? ifcWorkerUrl();
  let res: Response;
  try {
    res = await fetch(`${base}/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ format: IFC_IMPORT_FORMAT, version: IFC_IMPORT_VERSION, payload, ifc: Buffer.from(ifc).toString('base64'), name: options.name }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
    });
  } catch (error) {
    const why = error instanceof Error ? (error.name === 'TimeoutError' ? 'it did not answer in time' : error.message) : String(error);
    throw new IfcWorkerUnavailable(`the IFC worker at ${base} could not be reached: ${why}`, { cause: error });
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const detail = typeof (body as { error?: unknown } | null)?.error === 'string' ? (body as { error: string }).error : `HTTP ${String(res.status)}`;
    if (res.status === 422 || res.status === 400 || res.status === 413) throw new IfcImportRefused(detail, res.status);
    throw new Error(`the IFC worker failed to reconcile the file: ${detail}`);
  }
  const answer = body as Partial<IfcReconciliation> | null;
  if (answer?.format !== IFC_RECONCILIATION_FORMAT || !Array.isArray(answer.edits) || !Array.isArray(answer.report)) {
    throw new Error('the IFC worker answered something that is not a reconciliation');
  }
  return answer as IfcReconciliation;
}
