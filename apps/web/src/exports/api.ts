import { api, ApiError } from '../lib/api';

/**
 * Drawing exports (FLR-T-9.3) and the 3D model (FLR-T-9.2, glTF and USDZ): asked for, queued on the server's job queue, drawn by the worker,
 * then downloaded. A navigation downloads the file — the API answers `Content-Disposition:
 * attachment` — so the page stays put and the browser names it.
 */

export type ExportKind = 'pdf' | 'dxf' | 'ifc' | 'gltf' | 'usdz' | 'still' | 'shots';

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
  /** The sky it is seen under (FLR-T-13.4). */
  sky?: 'clear' | 'overcast' | 'dusk' | 'night' | 'studio';
}
/**
 * A shot list's sizes and qualities on the server (FLR-T-13.10, apps/worker/src/pathtrace/presets.ts
 * `SHOT_SIZES`): the long side, pixels — each view's frame sets the other.
 */
export const SHOT_SIZES = { small: 960, medium: 1440, large: 1920 } as const;
export type ShotSize = keyof typeof SHOT_SIZES;
export const shotWithinBudget = (size: ShotSize, quality: StillQuality): boolean => SHOT_SIZES[size] * SHOT_SIZES[size] * QUALITIES[quality] <= MAX_WORK;

/** A shot list's options (FLR-T-13.10): which saved views (default every one), how big and how clean. */
export interface ShotsRequest {
  views?: string[];
  size: ShotSize;
  quality: StillQuality;
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
  /**
   * A still's options, as asked for; null for any other export. `source` says where it was traced:
   * the worker's CPU (`server`), or the editor on the viewer's GPU (`gpu`, FLR-T-13.13), which has a
   * view in words and its samples instead of a size and a quality.
   */
  still?:
    | (Omit<StillRequest, 'camera' | 'room' | 'level' | 'sun' | 'size' | 'quality'> & {
        source?: 'server' | 'gpu';
        camera: string | null;
        room: string | null;
        level: string | null;
        size: StillSize | null;
        quality: StillQuality | null;
        sun: { azimuth: number; altitude: number } | null;
        view?: string | null;
        samples?: number | null;
      })
    | null;
  /** A shot list's options (FLR-T-13.10); null for any other export. */
  shots?: { views: string[] | null; size: ShotSize; quality: StillQuality } | null;
  /** While a still renders: the passes done and in all; a shot list adds the shot it is on, and how many. */
  progress?: { pass: number; passes: number; shot?: number; shots?: number } | null;
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
    /** A shot list's: each still in its ZIP. */
    shots?: { file: string; view: string; name: string; width: number; height: number; samples: number; ms: number }[];
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
  /** A shot list's (FLR-T-13.10). */
  shots?: ShotsRequest;
  /** glTF and USDZ: the doors closed (default) or open (FLR-T-13.8). */
  doors?: 'open' | 'closed';
  /** glTF and USDZ (FLR-T-13.12): the lights on, each at an output and colour temperature; default every one at full. */
  lighting?: { on: Record<string, { output?: number; cct?: number }> };
  /** PDF and DXF (FLR-T-18.3): a trade's view — an electrical plan — and a person's own layer states over it. */
  mode?: string;
  layers?: Record<string, 'on' | 'ghost' | 'off'>;
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
  const what = { pdf: 'PDF', dxf: 'DXF', ifc: 'IFC model', gltf: 'glTF', usdz: 'USDZ', still: 'Still', shots: 'Shot list' }[job.kind];
  switch (job.status) {
    case 'queued':
      return job.kind === 'ifc' ? `${what} waiting to be written` : job.kind === 'still' || job.kind === 'shots' ? `${what} waiting to be rendered` : `${what} waiting to be drawn`;
    case 'running':
      if (job.kind === 'shots') return job.progress?.shot !== undefined ? `Rendering the shot list… shot ${String(job.progress.shot)} of ${String(job.progress.shots ?? 0)}` : 'Rendering the shot list…';
      if (job.kind === 'still') return job.progress ? `Rendering the still… pass ${String(job.progress.pass)} of ${String(job.progress.passes)}` : 'Rendering the still…';
      return job.kind === 'ifc' ? `Writing the ${what}…` : `Drawing the ${what}…`;
    case 'failed':
      return `${what} failed: ${job.error ?? 'no reason was recorded'}`;
    case 'done': {
      const r = job.result;
      if (r?.sheets !== undefined) return `${r.name} · ${String(r.sheets.length)} ${r.sheets.length === 1 ? 'sheet' : 'sheets'}`;
      if (r?.files !== undefined) return `${r.name} · ${String(r.files.length)} ${r.files.length === 1 ? 'file' : 'files'}`;
      if (r?.shots !== undefined) return `${r.name} · ${String(r.shots.length)} ${r.shots.length === 1 ? 'shot' : 'shots'}`;
      if (r?.elements !== undefined) return `${r.name} · ${String(r.elements)} ${r.elements === 1 ? 'element' : 'elements'}`;
      return r?.name ?? what;
    }
  }
}

/** What a still traced on the viewer's GPU shows (FLR-T-13.13): saved with it, as its upload's query. */
export interface GpuStillFacts {
  /** The version traced: the one its glTF export was made from. */
  readonly version: string;
  /** The view, in words. */
  readonly view: string;
  readonly samples: number;
  readonly ms: number;
  readonly lights: 'on' | 'off';
  /** The lighting scene it was lit by (FLR-T-13.12): "Evening", "Evening (changed)". */
  readonly scene?: string;
  readonly time: 'day' | 'dusk' | 'night';
  /** The sky it was seen under (FLR-T-13.4). */
  readonly sky?: 'clear' | 'overcast' | 'dusk' | 'night' | 'studio';
  /** The GPU, as the browser names it. */
  readonly device?: string;
  readonly design?: Record<string, string>;
}

/** Save a still the editor path-traced on this device's GPU to the version's exports (FLR-T-13.13). */
export async function uploadStill(projectId: string, png: Blob, facts: GpuStillFacts): Promise<ExportJob> {
  const query = new URLSearchParams({
    version: facts.version,
    view: facts.view.slice(0, 200),
    samples: String(facts.samples),
    ms: String(Math.round(facts.ms)),
    lights: facts.lights,
    ...(facts.scene === undefined ? {} : { scene: facts.scene.slice(0, 200) }),
    time: facts.time,
    ...(facts.sky === undefined ? {} : { sky: facts.sky }),
    ...(facts.device === undefined || facts.device === '' ? {} : { device: facts.device.slice(0, 200) }),
    ...(facts.design === undefined || Object.keys(facts.design).length === 0 ? {} : { design: JSON.stringify(facts.design) }),
  });
  const res = await fetch(`/api/projects/${projectId}/exports/stills?${query.toString()}`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: png, credentials: 'same-origin' });
  const text = await res.text();
  let body: unknown;
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body ? String(body.error) : `saving the still failed with ${String(res.status)}`;
    throw new ApiError(res.status, message, body);
  }
  return (body as { export: ExportJob }).export;
}

export function startDownload(job: ExportJob): void {
  if (job.download !== null) window.location.assign(job.download);
}
