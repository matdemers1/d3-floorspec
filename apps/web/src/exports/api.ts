import { api } from '../lib/api';

/**
 * Drawing exports (FLR-T-9.3) and the 3D model (FLR-T-9.2, glTF and USDZ): asked for, queued on the server's job queue, drawn by the worker,
 * then downloaded. A navigation downloads the file — the API answers `Content-Disposition:
 * attachment` — so the page stays put and the browser names it.
 */

export type ExportKind = 'pdf' | 'dxf' | 'ifc' | 'gltf' | 'usdz';
export type PageName = 'tabloid' | 'arch-c' | 'arch-d' | 'letter' | 'a4' | 'a3';

export interface ExportJob {
  id: string;
  kind: ExportKind;
  status: 'queued' | 'running' | 'done' | 'failed';
  version: string;
  versionSeq: number | null;
  levels: string[] | null;
  page: PageName | null;
  error: string | null;
  result: { name: string; size: number; sheets?: { number: string; title: string }[]; files?: string[]; ifc?: { entities: Record<string, number> }; elements?: number } | null;
  createdAt: string;
  finishedAt: string | null;
  download: string | null;
}

export const PAGES: { value: PageName; label: string }[] = [
  { value: 'tabloid', label: 'Tabloid · 17 × 11 in' },
  { value: 'arch-c', label: 'ARCH C · 24 × 18 in' },
  { value: 'arch-d', label: 'ARCH D · 36 × 24 in' },
  { value: 'letter', label: 'Letter · 11 × 8.5 in' },
  { value: 'a3', label: 'A3 · 420 × 297 mm' },
  { value: 'a4', label: 'A4 · 297 × 210 mm' },
];

export interface ExportRequest {
  kind: ExportKind;
  levels?: string[];
  page?: PageName;
}

export async function requestExport(projectId: string, body: ExportRequest): Promise<ExportJob> {
  return (await api.post<{ export: ExportJob }>(`/api/projects/${projectId}/exports`, body)).export;
}

export async function listExports(projectId: string): Promise<ExportJob[]> {
  return (await api.get<{ exports: ExportJob[] }>(`/api/projects/${projectId}/exports`)).exports;
}

export async function getExport(projectId: string, id: string): Promise<ExportJob> {
  return (await api.get<{ export: ExportJob }>(`/api/projects/${projectId}/exports/${id}`)).export;
}

/**
 * Ask the server about a job until it is done or failed, every `everyMs` — a drawing takes a moment,
 * not minutes. `signal` stops it (the dialog closed).
 */
export async function untilFinished(projectId: string, job: ExportJob, onUpdate: (job: ExportJob) => void, signal?: AbortSignal, everyMs = 700): Promise<ExportJob> {
  let current = job;
  while (current.status === 'queued' || current.status === 'running') {
    await new Promise((resolve) => setTimeout(resolve, everyMs));
    if (signal?.aborted === true) return current;
    current = await getExport(projectId, current.id);
    onUpdate(current);
  }
  return current;
}

/** What a job is doing, in words. */
export function describeJob(job: ExportJob): string {
  const what = { pdf: 'PDF', dxf: 'DXF', ifc: 'IFC model', gltf: 'glTF', usdz: 'USDZ' }[job.kind];
  switch (job.status) {
    case 'queued':
      return job.kind === 'ifc' ? `${what} waiting to be written` : `${what} waiting to be drawn`;
    case 'running':
      return job.kind === 'ifc' ? `Writing the ${what}…` : `Drawing the ${what}…`;
    case 'failed':
      return `${what} failed: ${job.error ?? 'no reason was recorded'}`;
    case 'done': {
      const r = job.result;
      if (r?.sheets !== undefined) return `${r.name} · ${String(r.sheets.length)} ${r.sheets.length === 1 ? 'sheet' : 'sheets'}`;
      if (r?.files !== undefined) return `${r.name} · ${String(r.files.length)} ${r.files.length === 1 ? 'file' : 'files'}`;
      if (r?.elements !== undefined) return `${r.name} · ${String(r.elements)} ${r.elements === 1 ? 'element' : 'elements'}`;
      return r?.name ?? what;
    }
  }
}

export function startDownload(job: ExportJob): void {
  if (job.download !== null) window.location.assign(job.download);
}
