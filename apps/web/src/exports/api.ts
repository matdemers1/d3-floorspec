import { api } from '../lib/api';

/**
 * Drawing exports (FLR-T-9.3) and the 3D model (FLR-T-9.2, glTF and USDZ): asked for, queued on the server's job queue, drawn by the worker,
 * then downloaded. A navigation downloads the file — the API answers `Content-Disposition:
 * attachment` — so the page stays put and the browser names it.
 */

export type ExportKind = 'pdf' | 'dxf' | 'ifc' | 'gltf' | 'usdz' | 'still';

/**
 * A still's sizes and qualities, as the worker offers them (apps/worker/src/pathtrace/presets.ts) —
 * repeated here so the editor does not load the worker; the api refuses anything else.
 */
export const SIZES = { small: [640, 480], medium: [1024, 768], large: [1600, 1200] } as const;
export type StillSize = keyof typeof SIZES;
export const QUALITIES = { draft: 16, standard: 64, high: 256 } as const;
export type StillQuality = keyof typeof QUALITIES;
const MAX_WORK = 1024 * 768 * 256;
export const stillWithinBudget = (size: StillSize, quality: StillQuality): boolean => SIZES[size][0] * SIZES[size][1] * QUALITIES[quality] <= MAX_WORK;

/** A path-traced still's options (FLR-T-12.6): a named view or a room, a size, a quality, the sun. */
export interface StillRequest {
  camera?: 'sw' | 'se' | 'ne' | 'nw' | 'top';
  room?: string;
  level?: string;
  size: StillSize;
  quality: StillQuality;
  /** Degrees: azimuth clockwise from true north, altitude above the horizon. */
  sun?: { azimuth: number; altitude: number };
}
export type PageName = 'tabloid' | 'arch-c' | 'arch-d' | 'letter' | 'a4' | 'a3';

export interface ExportJob {
  id: string;
  kind: ExportKind;
  status: 'queued' | 'running' | 'done' | 'failed';
  version: string;
  versionSeq: number | null;
  levels: string[] | null;
  page: PageName | null;
  /** The design it was made in (Core 19.6): option set → option; null for the primary design asked for implicitly, or an IFC export. */
  design: Record<string, string> | null;
  /** A still's options, as asked for; null for any other export. */
  still?: (Omit<StillRequest, 'camera' | 'room' | 'level' | 'sun'> & { camera: string | null; room: string | null; level: string | null; sun: { azimuth: number; altitude: number } | null }) | null;
  /** While a still renders: the passes done and in all. */
  progress?: { pass: number; passes: number } | null;
  error: string | null;
  result: {
    name: string;
    size: number;
    sheets?: { number: string; title: string }[];
    files?: string[];
    ifc?: { entities: Record<string, number> };
    elements?: number;
    /** A still's: its label, pixels, samples, camera in words, the sun, and how long it took (ms). */
    label?: string;
    width?: number;
    height?: number;
    samples?: number;
    camera?: string;
    sun?: { azimuth: number; altitude: number; source: 'yours' | 'default' };
    ms?: number;
  } | null;
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
  /** PDF, DXF, glTF and USDZ: one option per set (FLR-T-9.7); the server refuses one for IFC. */
  design?: Record<string, string>;
  /** A still's options (FLR-T-12.6). */
  still?: StillRequest;
}

/** The kinds made in one design: every export but the IFC model, which is of the primary. */
export const takesDesign = (kind: ExportKind): boolean => kind !== 'ifc';

/** An option set as the Export dialog and the job list name it — structurally the editor's OptionSetView. */
export interface DesignSet {
  readonly id: string;
  readonly name: string;
  readonly primary: string;
  readonly options: readonly { readonly id: string; readonly name: string }[];
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A document's option sets with their options' names (Core 0.3, 19.1), in ID order, read from the
 * JSON as it is — for the dashboard, which has the document but not the editor's model.
 */
export function designSetsOf(document: unknown): DesignSet[] {
  if (!isObject(document) || !isObject(document['optionSets'])) return [];
  const options = isObject(document['options']) ? document['options'] : {};
  return Object.entries(document['optionSets'])
    .filter((e): e is [string, Json] => isObject(e[1]) && typeof e[1]['primary'] === 'string')
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([id, set]) => ({
      id,
      name: typeof set['name'] === 'string' ? set['name'] : id,
      primary: set['primary'] as string,
      options: Object.entries(options)
        .filter((e): e is [string, Json] => isObject(e[1]) && e[1]['set'] === id)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([o, opt]) => ({ id: o, name: typeof opt['name'] === 'string' ? opt['name'] : o })),
    }));
}

/** "Kitchen B": a set's name and its option's, as the editor's options chip says them. */
export function optionChoiceLabel(set: DesignSet, option: string): string {
  return `${set.name} ${set.options.find((o) => o.id === option)?.name ?? option}`;
}

/** "Kitchen B, Stair north": a design, one choice per set, by name where the set is known. */
export function designLabel(design: Readonly<Record<string, string>>, sets: readonly DesignSet[] = []): string {
  return Object.entries(design)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([set, option]) => {
      const known = sets.find((s) => s.id === set);
      return known === undefined ? `${set} ${option}` : optionChoiceLabel(known, option);
    })
    .join(', ');
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

/** What a job is doing, in words — and, when it was made in a chosen design, which (FLR-T-9.7). */
export function describeJob(job: ExportJob, sets: readonly DesignSet[] = []): string {
  const what = describeStatus(job);
  return job.design === null || Object.keys(job.design).length === 0 ? what : `${what} · design ${designLabel(job.design, sets)}`;
}

function describeStatus(job: ExportJob): string {
  const what = { pdf: 'PDF', dxf: 'DXF', ifc: 'IFC model', gltf: 'glTF', usdz: 'USDZ', still: 'Still' }[job.kind];
  switch (job.status) {
    case 'queued':
      return job.kind === 'ifc' ? `${what} waiting to be written` : job.kind === 'still' ? 'Still waiting to be rendered' : `${what} waiting to be drawn`;
    case 'running':
      if (job.kind === 'still') return job.progress ? `Rendering the still… pass ${String(job.progress.pass)} of ${String(job.progress.passes)}` : 'Rendering the still…';
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
