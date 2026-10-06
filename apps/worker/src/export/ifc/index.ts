/**
 * IFC4 Reference View export (FLR-T-9.4; FLR-REQ-131).
 *
 * The IFC file is written by the Python IFC worker (`workers/ifc`) through IfcOpenShell, which is
 * LGPL, so it runs in its own process and image and this side only talks to it over HTTP. The split
 * is deliberate: everything exact stays here, in the engine — the document is evaluated and derived
 * once (FLR-ADR-010) — and the worker receives the document, its derived values and the version's
 * facts as one JSON payload, maps them to IFC entities (Annex A of Floorspec Core) and answers with
 * the file's bytes. The queue protocol (claim, retry, store the file) stays in one place: the drain.
 *
 * `IFC_WORKER_URL` names the worker: `http://ifc-worker:3410` on the production compose network,
 * `http://127.0.0.1:3410` elsewhere (`python -m floorspec_ifc serve` in workers/ifc).
 */
import { contentHash, CORE_VERSION, deriveEvaluation, ENGINE_VERSION, evaluate, InvalidDocumentError, OFFICIAL_READER, type Derived, type FloorspecDocument, type ValidateOptions } from '@floorspec/engine';

/** A reader (Core 1.6.4, 12.2): the extensions it implements and knows. */
export type IfcReader = Omit<ValidateOptions, 'design'>;

/** The payload's format and version; the worker refuses any other. */
export const IFC_PAYLOAD_FORMAT = 'floorspec-ifc-payload';
export const IFC_PAYLOAD_VERSION = 1;
export const IFC_CONTENT_TYPE = 'application/x-step';
export const DEFAULT_IFC_WORKER_PORT = 3410;

export interface IfcVersionFacts {
  /** The version's content hash (64 hex). */
  readonly hash: string;
  /** Its number on main, when it has one. */
  readonly seq?: number | null;
  /** When the version was made: the file's timestamp, so the same version gives the same bytes. */
  readonly at: Date;
}

/** What the IFC worker receives (workers/ifc/floorspec_ifc/payload.py reads it). */
export interface IfcPayload {
  readonly format: typeof IFC_PAYLOAD_FORMAT;
  readonly version: typeof IFC_PAYLOAD_VERSION;
  /** The content hash of the version: carried by every element's Floorspec_Identity. */
  readonly hash: string;
  /** The design that is exported (19.7): the document's view, in which nothing is in an option. */
  readonly document: FloorspecDocument;
  /** Everything the engine derives from it — wall outlines, room polygons, roofs, stairs… */
  readonly derived: Derived;
  /** For a document with design options: each option set's ID → the option this design chooses. */
  readonly design: Readonly<Record<string, string>>;
  readonly file: { readonly name: string; readonly timestamp: string; readonly versionSeq: number | null };
  readonly engine: { readonly version: string; readonly core: string };
}

export interface IfcSummary {
  readonly schema: string;
  readonly view: string;
  /** How many of each IFC class the file holds, for the classes worth showing. */
  readonly entities: Readonly<Record<string, number>>;
  readonly validation: { readonly errors: number };
}

export interface IfcResult {
  readonly name: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly summary: IfcSummary;
}

const slug = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '-')
    .slice(0, 60) || 'floorspec';

/** The file's name: the project, then the version's number on main or its hash. */
export function ifcFileName(projectName: string, version: IfcVersionFacts): string {
  const v = version.seq === undefined || version.seq === null ? version.hash.slice(0, 8) : `v${String(version.seq)}`;
  return `${slug(projectName)}-${v}.ifc`;
}

/**
 * The payload for one version: evaluated once and derived here, exactly. Throws InvalidDocumentError
 * for a document that is not valid — the api refuses those before a job is queued, and the job row
 * is data, so the worker checks again. It is read with `reader`, default `OFFICIAL_READER`, the
 * reader the api and the editor run (FLR-T-12.10): a model that requires an official extension is
 * exported, and one the editor calls invalid is refused.
 */
export function ifcPayload(document: object, version: IfcVersionFacts, reader: IfcReader = OFFICIAL_READER): IfcPayload {
  const ev = evaluate(document, reader);
  if (!ev.valid || !ev.document || !ev.analysis) throw new InvalidDocumentError(ev.diagnostics);
  const derived = deriveEvaluation(ev);
  const view = ev.view ?? ev.document;
  const design: Record<string, string> = {};
  for (const set of Object.keys(derived.options ?? {}).sort()) design[set] = derived.options![set]!.chosen;
  // The version's hash is the content hash of its document; a payload built from a bare document
  // (a test, a sample) carries the document's own.
  const hash = /^[0-9a-f]{64}$/.test(version.hash) ? version.hash : contentHash(ev.document);
  return {
    format: IFC_PAYLOAD_FORMAT,
    version: IFC_PAYLOAD_VERSION,
    hash,
    document: view,
    derived,
    design,
    file: { name: ifcFileName(view.project.name, { ...version, hash }), timestamp: version.at.toISOString().replace(/\.\d{3}Z$/, 'Z'), versionSeq: version.seq ?? null },
    engine: { version: ENGINE_VERSION, core: CORE_VERSION },
  };
}

export interface IfcExportOptions {
  readonly version: IfcVersionFacts;
  /** The IFC worker's base URL. Default: `IFC_WORKER_URL`, else the compose name in production, else loopback. */
  readonly workerUrl?: string;
  /** How long to wait for the file (ms). Default 120000. */
  readonly timeoutMs?: number;
  /** The reader the model is validated with. Default `OFFICIAL_READER` (see `ifcPayload`). */
  readonly reader?: IfcReader;
}

/** The IFC worker's base URL from the environment. */
export function ifcWorkerUrl(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const set = env['IFC_WORKER_URL'];
  if (set !== undefined && set !== '') return set.replace(/\/+$/, '');
  return env['NODE_ENV'] === 'production' ? `http://ifc-worker:${String(DEFAULT_IFC_WORKER_PORT)}` : `http://127.0.0.1:${String(DEFAULT_IFC_WORKER_PORT)}`;
}

function summaryOf(header: string | null): IfcSummary {
  const fallback: IfcSummary = { schema: 'IFC4', view: 'ReferenceView_V1.2', entities: {}, validation: { errors: 0 } };
  if (header === null) return fallback;
  try {
    const s = JSON.parse(header) as Partial<IfcSummary>;
    return { ...fallback, ...s };
  } catch {
    return fallback;
  }
}

/** Export one version as IFC4 ADD2 TC1 Reference View, through the IFC worker. */
export async function exportIfc(document: object, options: IfcExportOptions): Promise<IfcResult> {
  const payload = ifcPayload(document, options.version, options.reader);
  const base = options.workerUrl ?? ifcWorkerUrl();
  let res: Response;
  try {
    res = await fetch(`${base}/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: IFC_CONTENT_TYPE },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
    });
  } catch (error) {
    const why = error instanceof Error ? (error.name === 'TimeoutError' ? 'it did not answer in time' : error.message) : String(error);
    throw new Error(`the IFC worker at ${base} could not be reached: ${why}`, { cause: error });
  }
  if (!res.ok) {
    let detail = `HTTP ${String(res.status)}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string') detail = body.error;
    } catch {
      // Not JSON: the status says enough.
    }
    throw new Error(`the IFC worker refused the export: ${detail}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { name: payload.file.name, contentType: IFC_CONTENT_TYPE, bytes, summary: summaryOf(res.headers.get('x-floorspec-ifc-summary')) };
}
