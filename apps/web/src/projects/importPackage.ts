import { Package, type Diagnostic } from '@floorspec/engine';
import { DEFAULT_LIMITS, PackageError, isZip, readPackage } from '@floorspec/package';
import { summarize, type ModelSummary } from './model';

/**
 * Reading an import in the browser (FLR-T-9.1): a `.floorspec.json` document, or a `.floorspec`
 * package opened here by @floorspec/package — the same reader, with the same zip-slip and size
 * checks, the server runs — and checked by the engine, a package validator when there is a package.
 * Nothing is uploaded to find out whether a file is valid. Creating the project sends the file's
 * bytes as they are to `POST /api/projects/import/floorspec`, which checks everything again,
 * stores the package's files and builds the project as Floorspec Ops.
 */

/** A document: large enough for any house; small enough that a wrong file does not stall the tab. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
/** A package: the server's import limit (apps/server/src/routes/package.ts). */
export const MAX_PACKAGE_BYTES = 128 * 1024 * 1024;

export interface ReadImport {
  readonly kind: 'document' | 'package';
  /** The file as it is: what is sent. */
  readonly bytes: Uint8Array;
  readonly summary: ModelSummary;
  /** A package's contents: the files its assets name, and what else it holds. */
  readonly files: number;
  readonly missing: readonly string[];
  readonly ignored: readonly string[];
}

export type ReadOutcome = { status: 'read'; read: ReadImport } | { status: 'unreadable'; message: string };

const MB = 1024 * 1024;

/** What a file is and whether it is valid, from its bytes. */
export function readImportBytes(name: string, bytes: Uint8Array): ReadOutcome {
  const kind = isZip(bytes) || name.toLowerCase().endsWith('.floorspec') ? 'package' : 'document';
  if (kind === 'document') {
    if (bytes.length > MAX_DOCUMENT_BYTES) return { status: 'unreadable', message: `The file is larger than ${String(MAX_DOCUMENT_BYTES / MB)} MB, which no Floorspec house needs.` };
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return { status: 'unreadable', message: 'The file is not text: choose a .floorspec.json document or a .floorspec package.' };
    }
    return { status: 'read', read: { kind, bytes, summary: summarize(text), files: 0, missing: [], ignored: [] } };
  }
  if (bytes.length > MAX_PACKAGE_BYTES) return { status: 'unreadable', message: `The package is larger than ${String(MAX_PACKAGE_BYTES / MB)} MB.` };
  try {
    const opened = readPackage(bytes, { ...DEFAULT_LIMITS, maxArchiveBytes: MAX_PACKAGE_BYTES });
    const summary = summarize(new TextDecoder().decode(opened.document), { package: new Package(opened.files) });
    return { status: 'read', read: { kind, bytes, summary, files: opened.files.size, missing: opened.missing.map((m) => m.path), ignored: opened.ignored } };
  } catch (error) {
    if (error instanceof PackageError) return { status: 'unreadable', message: `This is not a package that can be imported: ${error.message}.` };
    throw error;
  }
}

export async function readImportFile(file: File): Promise<ReadOutcome> {
  if (file.size > MAX_PACKAGE_BYTES) return { status: 'unreadable', message: `The file is larger than ${String(MAX_PACKAGE_BYTES / MB)} MB.` };
  return readImportBytes(file.name, new Uint8Array(await file.arrayBuffer()));
}

export interface ImportAnswer {
  id: string;
  name: string;
  head: string;
  source: 'document' | 'package';
  diagnostics: Diagnostic[];
  stored: string[];
  missing: string[];
  ignored: string[];
  stripped: { asset: string; removed: string[] }[];
}

export type ImportOutcome = { status: 'created'; answer: ImportAnswer } | { status: 'rejected'; message: string; diagnostics: Diagnostic[] } | { status: 'failed'; message: string };

/** Send the file to the server, which makes the project. */
export async function importToServer(bytes: Uint8Array, name: string): Promise<ImportOutcome> {
  let res: Response;
  try {
    res = await fetch('/api/projects/import/floorspec', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/octet-stream', 'x-project-name': encodeURIComponent(name) },
      body: new Blob([bytes as Uint8Array<ArrayBuffer>]),
    });
  } catch {
    return { status: 'failed', message: 'The server could not be reached. Try again.' };
  }
  const body = (await res.json().catch(() => ({}))) as Partial<ImportAnswer> & { error?: string; detail?: string; diagnostics?: Diagnostic[] };
  if (res.status === 201 && typeof body.id === 'string') return { status: 'created', answer: body as ImportAnswer };
  const message = [body.error, body.detail].filter((x) => typeof x === 'string' && x !== '').join(': ') || `The server answered ${String(res.status)}.`;
  if (Array.isArray(body.diagnostics) && body.diagnostics.length > 0) return { status: 'rejected', message, diagnostics: body.diagnostics };
  return { status: 'failed', message: message.charAt(0).toUpperCase() + message.slice(1) };
}
