import { ApiError } from '../lib/api';

/**
 * The IFC round trip (FLR-T-9.5), as the editor uses it: an IFC file exported from this project,
 * edited in another tool, uploaded back. The upload is the file's own bytes, with its name in
 * `X-File-Name`; the answer is the proposed changeset (null when the file changed nothing that maps)
 * and the report of what did not come across.
 */

export const IFC_ACCEPT = '.ifc,application/x-step';

export interface ImportReportEntry {
  /** `unmapped`: no Floorspec equivalent; `ambiguous`: the file says it two ways; `rejected`: the
   * applier refused it; `note`: nothing to do. */
  severity: 'unmapped' | 'ambiguous' | 'rejected' | 'note';
  globalId: string | null;
  entity: string | null;
  element: string | null;
  kind: string | null;
  name: string | null;
  change: string;
  reason: string;
}

export interface ImportReport {
  source: 'ifc';
  file: { name: string; bytes: number; schema: string | null; originatingSystem: string | null };
  base: string;
  documentHash: string | null;
  edits: { element: string; kind: string; changes: string[] }[];
  entries: ImportReportEntry[];
  counts: Record<string, number>;
}

export interface ImportAnswer {
  changeset: { id: string; name: string } | null;
  report: ImportReport;
}

/** Upload an edited IFC file; `base` names the version it is based on when it does not say. */
export async function importIfc(projectId: string, file: Blob & { name?: string }, base?: string): Promise<ImportAnswer> {
  const headers = new Headers({ 'content-type': 'application/x-step' });
  if (file.name !== undefined && file.name !== '') headers.set('x-file-name', encodeURIComponent(file.name));
  const query = base === undefined ? '' : `?base=${base}`;
  const res = await fetch(`/api/projects/${projectId}/imports/ifc${query}`, { method: 'POST', headers, body: file, credentials: 'same-origin' });
  const text = await res.text();
  let body: unknown;
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const problem = body as { error?: string; title?: string; detail?: string } | undefined;
    const message = problem?.title !== undefined ? `${problem.title}${problem.detail === undefined ? '' : `. ${problem.detail}`}` : (problem?.error ?? `the import failed with ${String(res.status)}`);
    throw new ApiError(res.status, message, body);
  }
  return body as ImportAnswer;
}

/** Whether an entry needs the person's attention: everything but a note. */
export function needsAttention(entry: ImportReportEntry): boolean {
  return entry.severity !== 'note';
}
