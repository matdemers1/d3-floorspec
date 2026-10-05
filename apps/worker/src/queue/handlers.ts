/**
 * What each kind of job does. Exports read one version and make one file; their parameters were
 * checked by the api when the job was queued, and are checked again here because a job row is data.
 */
import { exportDxf, exportPdf, PAGES, type PageName } from '../export/drawings/index.js';
import { exportIfc } from '../export/ifc/index.js';
import { assetDirImages, exportGltf, exportUsdz, type ImageSource } from '../export/gltf/index.js';
import { PRESETS, render3dPng, type Preset } from '../render3d/index.js';

export interface JobRow {
  readonly id: string;
  readonly projectId: string;
  readonly kind: string;
  readonly params: unknown;
  readonly versionHash: string;
  /**
   * The asset digests the job's project has claimed (`project_assets`, FLR-T-8.2), filled in by the
   * drain: a 3D export embeds only these, so a model cannot name another project's upload into its
   * file. Absent (a direct call, a test): no restriction.
   */
  readonly claimed?: ReadonlySet<string>;
}

export interface JobFile {
  readonly name: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  /** Anything else worth showing about the file: its sheets, its files. */
  readonly summary?: Record<string, unknown>;
}

export type Handler = (document: object, job: JobRow) => Promise<JobFile>;

/** The parameters of an export job, as the api writes them. */
export interface ExportParams {
  readonly levels?: readonly string[];
  readonly page?: PageName;
  /** The version's number on main, when it has one, and when it was made (ISO 8601). */
  readonly versionSeq?: number | null;
  readonly versionAt: string;
  /** The design to export or draw (FLR-T-9.2, FLR-T-9.7), option set → option; default the primary. IFC ignores it. */
  readonly design?: Record<string, string>;
}

/** A design input from a job row: an object of string → string, or nothing. */
function designOf(raw: unknown): Record<string, string> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw);
  if (!entries.every(([, v]) => typeof v === 'string')) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of entries) Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
  return out;
}

export function exportParams(raw: unknown): ExportParams {
  const p = (raw ?? {}) as Record<string, unknown>;
  const levels = Array.isArray(p['levels']) && p['levels'].every((l) => typeof l === 'string') ? (p['levels']) : undefined;
  const page = typeof p['page'] === 'string' && Object.hasOwn(PAGES, p['page']) ? (p['page'] as PageName) : undefined;
  const seq = typeof p['versionSeq'] === 'number' && Number.isInteger(p['versionSeq']) ? p['versionSeq'] : null;
  const at = typeof p['versionAt'] === 'string' && !Number.isNaN(Date.parse(p['versionAt'])) ? p['versionAt'] : new Date(0).toISOString();
  const design = designOf(p['design']);
  return { ...(levels === undefined ? {} : { levels }), ...(page === undefined ? {} : { page }), versionSeq: seq, versionAt: at, ...(design === undefined ? {} : { design }) };
}

/** The parameters of a 3D render job (FLR-T-8.5), as the api writes them. */
export interface Render3dParams {
  readonly camera?: Preset;
  readonly room?: string;
  readonly level?: string;
  readonly highlight?: readonly string[];
  readonly width?: number;
  readonly design?: Record<string, string>;
}

export function render3dParams(raw: unknown): Render3dParams {
  const p = (raw ?? {}) as Record<string, unknown>;
  const camera = typeof p['camera'] === 'string' && (PRESETS as readonly string[]).includes(p['camera']) ? (p['camera'] as Preset) : undefined;
  const str = (k: string): string | undefined => (typeof p[k] === 'string' && p[k] !== '' ? p[k] : undefined);
  const room = str('room');
  const level = str('level');
  const highlight = Array.isArray(p['highlight']) && p['highlight'].every((h) => typeof h === 'string') ? p['highlight'] : undefined;
  const width = typeof p['width'] === 'number' && Number.isInteger(p['width']) ? p['width'] : undefined;
  const design = designOf(p['design']);
  return {
    ...(camera === undefined ? {} : { camera }),
    ...(room === undefined ? {} : { room }),
    ...(level === undefined ? {} : { level }),
    ...(highlight === undefined ? {} : { highlight }),
    ...(width === undefined ? {} : { width }),
    ...(design === undefined ? {} : { design }),
  };
}

/** The 3D exports' options: one version, its levels, its design, and the asset store's maps when the worker can read them. */
function modelOptions(job: JobRow, source: ImageSource | undefined) {
  const p = exportParams(job.params);
  const claimed = job.claimed;
  const images: ImageSource | undefined = source === undefined || claimed === undefined ? source : (asset) => (claimed.has(asset.sha256) ? source(asset) : undefined);
  return {
    version: { hash: job.versionHash, seq: p.versionSeq ?? null },
    ...(p.levels === undefined ? {} : { levels: p.levels }),
    ...(p.design === undefined ? {} : { design: p.design }),
    ...(images === undefined ? {} : { images }),
  };
}

function options(job: JobRow) {
  const p = exportParams(job.params);
  return {
    version: { hash: job.versionHash, seq: p.versionSeq ?? null, at: new Date(p.versionAt) },
    ...(p.levels === undefined ? {} : { levels: p.levels }),
    ...(p.page === undefined ? {} : { page: p.page }),
    ...(p.design === undefined ? {} : { design: p.design }),
  };
}

export interface HandlerOptions {
  /**
   * The asset store's directory (`ASSET_DIR`, content-addressed `ab/cd/<sha256>`): glTF and USDZ
   * exports embed the PNG and JPEG maps they find there. The worker mounts the api's volume
   * read-only; without it, exports carry colours and list the maps they left out.
   */
  readonly assetDir?: string;
}

/** The job table, reading maps from `assetDir` when it is given. */
export function createHandlers(opts: HandlerOptions = {}): Readonly<Record<string, Handler>> {
  const images = assetDirImages(opts.assetDir);
  return {
    'export.pdf': async (document, job) => {
      const pdf = await exportPdf(document, options(job));
      return { name: pdf.name, contentType: pdf.contentType, bytes: pdf.bytes, summary: { sheets: pdf.sheets.map((s) => ({ number: s.number, title: s.title })), design: pdf.design } };
    },
    'export.dxf': (document, job) => {
      const dxf = exportDxf(document, options(job));
      return Promise.resolve({ name: dxf.name, contentType: dxf.contentType, bytes: dxf.bytes, summary: { files: dxf.files.map((f) => f.name), design: dxf.design } });
    },
  // FLR-T-9.4: derived here, written by the Python IFC worker (IfcOpenShell is LGPL: its own process).
    'export.ifc': async (document, job) => {
      const ifc = await exportIfc(document, { version: options(job).version });
      return { name: ifc.name, contentType: ifc.contentType, bytes: ifc.bytes, summary: { ifc: ifc.summary } };
    },
    'export.gltf': async (document, job) => {
      const file = await exportGltf(document, modelOptions(job, images));
      return { name: file.name, contentType: file.contentType, bytes: file.bytes, summary: file.summary };
    },
    'export.usdz': async (document, job) => {
      const file = await exportUsdz(document, modelOptions(job, images));
      return { name: file.name, contentType: file.contentType, bytes: file.bytes, summary: file.summary };
    },
    /** FLR-T-8.5: a PNG of the 3D model from a named view or a room; the api waits for it. */
    'render.3d': async (document, job) => {
      const r = await render3dPng(document, render3dParams(job.params));
      return { name: `render-${job.versionHash.slice(0, 8)}.png`, contentType: 'image/png', bytes: r.png, summary: { width: r.width, height: r.height, camera: r.camera, design: r.design } };
    },
  };
}

/** The job table of this process: maps from `ASSET_DIR` when it is set. */
export const handlers: Readonly<Record<string, Handler>> = createHandlers({ ...(process.env['ASSET_DIR'] === undefined ? {} : { assetDir: process.env['ASSET_DIR'] }) });
