/**
 * What each kind of job does. Exports read one version and make one file; their parameters were
 * checked by the api when the job was queued, and are checked again here because a job row is data.
 */
import { isRenovationFilter, type RenovationFilter } from '@floorspec/render2d';
import { exportDxf, exportPdf, PAGES, type PageName } from '../export/drawings/index.js';
import { exportIfc } from '../export/ifc/index.js';
import { assetDirImages, assetDirModels, exportGltf, exportUsdz, type ImageSource } from '../export/gltf/index.js';
import { PRESETS, render3dCompare, render3dPng, type Preset } from '../render3d/index.js';
import { renderPair } from '../pathtrace/pair.js';
import { normalizeOn, type Lighting } from '@floorspec/mesh';
import { isLayerState, isModeId, isPlanStyle, PLAN_LAYERS, type LayerState, type ModeId, type PlanLayer, type PlanStyle } from '@floorspec/render2d';
import { AT_PATTERN, LIGHTS, QUALITIES, renderLit, renderStill, SHOT_SIZES, shotWithinBudget, SIZES, SKIES, TIMES, withinBudget, type Lights, type Quality, type ShotSize, type Size, type Sky, type SunInput, type TimeOfDay } from '../pathtrace/index.js';
import { renderSavedView, renderShots, type Shot } from '../pathtrace/views.js';
import { storeZip } from '../export/gltf/zip.js';
import { FILM_FORMATS, FILM_LIGHTS, FILM_QUALITIES, FILM_RATES, FILM_SIZES, renderFilm, type FilmFormat, type FilmLight, type FilmQuality, type FilmRate, type FilmSize } from '../film/index.js';
import { timelapseProblem, type Timelapse } from '@floorspec/mesh/sky';

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
  /**
   * Tell the queue how far a long job has got (FLR-T-12.6): the drain writes it to the job's
   * `progress`, where the api shows it. Absent: nobody is listening.
   */
  readonly progress?: (progress: Record<string, unknown>) => Promise<void>;
  /**
   * Aborted when the job is no longer this worker's — cancelled by a person (FLR-T-14.10) — which the
   * drain notices within a second whether or not the job is reporting: a long job stops at once.
   */
  readonly signal?: AbortSignal;
  /**
   * Another version's document, by its hash (FLR-T-14.4): a matched pair's B, a comparison's A. The
   * api checked the hash is one this job's project reached; the drain reads it from the store.
   */
  readonly load?: (hash: string) => Promise<object>;
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
  /** A 3D model's doors closed (default) or open (FLR-T-13.8): what the editor's GPU still traces (FLR-T-13.13). */
  readonly doors?: 'open' | 'closed';
  /** A 3D model's lights (FLR-T-13.12): those on, at their output and colour temperature; default every one at full. */
  readonly lighting?: Lighting;
  /** A drawing in a trade's view (FLR-T-18.3), and a person's own layer states over it. */
  readonly mode?: ModeId;
  readonly layers?: Partial<Record<PlanLayer, LayerState>>;
  /** A PDF's plan style (FLR-T-18.5). */
  readonly style?: PlanStyle;
  /** A PDF's or DXF's renovation plan (FLR-T-18.13). */
  readonly renovation?: RenovationFilter;
}

/** Layer states from a job row (FLR-T-18.3): known layers with known states, or nothing. */
function layersOf(raw: unknown): Partial<Record<PlanLayer, LayerState>> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const out: Partial<Record<PlanLayer, LayerState>> = {};
  for (const l of PLAN_LAYERS) {
    const v = (raw as Record<string, unknown>)[l];
    if (isLayerState(v)) out[l] = v;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** A lighting from a job row (FLR-T-13.12): `{ on: { id: { output, cct } } }`, made well-formed, or nothing. */
export function lightingOf(raw: unknown): Lighting | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const on = (raw as { on?: unknown }).on;
  if (typeof on !== 'object' || on === null || Array.isArray(on)) return undefined;
  return { on: normalizeOn(on) };
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
  const doors = p['doors'] === 'open' || p['doors'] === 'closed' ? p['doors'] : undefined;
  const lighting = lightingOf(p['lighting']);
  const mode = isModeId(p['mode']) ? p['mode'] : undefined;
  const layers = layersOf(p['layers']);
  const style = isPlanStyle(p['style']) ? p['style'] : undefined;
  const renovation = isRenovationFilter(p['renovation']) ? p['renovation'] : undefined;
  return {
    ...(levels === undefined ? {} : { levels }),
    ...(page === undefined ? {} : { page }),
    versionSeq: seq,
    versionAt: at,
    ...(design === undefined ? {} : { design }),
    ...(doors === undefined ? {} : { doors }),
    ...(lighting === undefined ? {} : { lighting }),
    ...(mode === undefined ? {} : { mode }),
    ...(layers === undefined ? {} : { layers }),
    ...(style === undefined ? {} : { style }),
    ...(renovation === undefined ? {} : { renovation }),
  };
}

/** The parameters of a 3D render job (FLR-T-8.5), as the api writes them. */
export interface Render3dParams {
  readonly camera?: Preset;
  readonly room?: string;
  readonly level?: string;
  readonly highlight?: readonly string[];
  readonly width?: number;
  readonly design?: Record<string, string>;
  /** FLR-T-12.22: the luminaires on or off — path-traced, at night unless `time` says otherwise. */
  readonly lights?: Lights;
  readonly time?: TimeOfDay;
  /** FLR-T-13.8: the doors closed (default) or open. */
  readonly doors?: 'open' | 'closed';
  /** FLR-T-13.4: the sky it is seen under; FLR-T-13.9: a date and time at the site. */
  readonly sky?: Sky;
  readonly at?: string;
  /** FLR-T-13.12: the lighting scene, by name (the api resolved it), and what it turns on. */
  readonly scene?: string;
  readonly lighting?: Lighting;
  /** FLR-T-13.10: a saved view (FS_views), by its ID or name — path-traced as the photograph it describes. */
  readonly view?: string;
  /**
   * FLR-T-14.4: a comparison — the job's version is B (a changeset's head), this is A (main's head):
   * both rasterized through one camera and set side by side, B's changes lit.
   */
  readonly compare?: { readonly hash: string; readonly design?: Record<string, string> };
}

/** A job's sky and date and time, when they are one of the presets and a date and time. */
function skyParams(p: Record<string, unknown>): { sky?: Sky; at?: string } {
  const sky = typeof p['sky'] === 'string' && (SKIES as readonly string[]).includes(p['sky']) ? (p['sky'] as Sky) : undefined;
  const at = typeof p['at'] === 'string' && AT_PATTERN.test(p['at']) ? p['at'] : undefined;
  return { ...(sky === undefined ? {} : { sky }), ...(at === undefined ? {} : { at }) };
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
  const lights = typeof p['lights'] === 'string' && (LIGHTS as readonly string[]).includes(p['lights']) ? (p['lights'] as Lights) : undefined;
  const time = typeof p['time'] === 'string' && (TIMES as readonly string[]).includes(p['time']) ? (p['time'] as TimeOfDay) : undefined;
  const doors = p['doors'] === 'open' || p['doors'] === 'closed' ? p['doors'] : undefined;
  const scene = str('scene');
  const lighting = lightingOf(p['lighting']);
  const view = str('view');
  const c = p['compare'];
  const compareHash = isRecord(c) && typeof c['hash'] === 'string' && /^[0-9a-f]{64}$/.test(c['hash']) ? c['hash'] : undefined;
  const compareDesign = isRecord(c) ? designOf(c['design']) : undefined;
  return {
    ...(compareHash === undefined ? {} : { compare: { hash: compareHash, ...(compareDesign === undefined ? {} : { design: compareDesign }) } }),
    ...(view === undefined ? {} : { view }),
    ...(scene === undefined ? {} : { scene }),
    ...(lighting === undefined ? {} : { lighting }),
    ...(camera === undefined ? {} : { camera }),
    ...(room === undefined ? {} : { room }),
    ...(level === undefined ? {} : { level }),
    ...(highlight === undefined ? {} : { highlight }),
    ...(width === undefined ? {} : { width }),
    ...(design === undefined ? {} : { design }),
    ...(lights === undefined ? {} : { lights }),
    ...(time === undefined ? {} : { time }),
    ...(doors === undefined ? {} : { doors }),
    ...skyParams(p),
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The parameters of a path-traced still (FLR-T-12.6), as the api writes them. */
export interface StillParams {
  readonly camera?: Preset;
  readonly room?: string;
  readonly level?: string;
  readonly size: Size;
  readonly quality: Quality;
  readonly sun?: SunInput;
  readonly design?: Record<string, string>;
  readonly sky?: Sky;
  readonly at?: string;
}

export function stillParams(raw: unknown): StillParams {
  const p = (raw ?? {}) as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof p[k] === 'string' && p[k] !== '' ? p[k] : undefined);
  const camera = typeof p['camera'] === 'string' && (PRESETS as readonly string[]).includes(p['camera']) ? (p['camera'] as Preset) : undefined;
  const size = typeof p['size'] === 'string' && Object.hasOwn(SIZES, p['size']) ? (p['size'] as Size) : 'medium';
  const quality = typeof p['quality'] === 'string' && Object.hasOwn(QUALITIES, p['quality']) ? (p['quality'] as Quality) : 'standard';
  if (!withinBudget(size, quality)) throw new RangeError(`a ${size} still at ${quality} quality is more work than a still may take`);
  const s: unknown = p['sun'];
  const sun = isRecord(s) && typeof s['azimuth'] === 'number' && typeof s['altitude'] === 'number' && Number.isFinite(s['azimuth']) && s['altitude'] > 0 && s['altitude'] <= 90 ? { azimuth: s['azimuth'], altitude: s['altitude'] } : undefined;
  const room = str('room');
  const level = str('level');
  const design = designOf(p['design']);
  return {
    ...(camera === undefined ? {} : { camera }),
    ...(room === undefined ? {} : { room }),
    ...(level === undefined ? {} : { level }),
    size,
    quality,
    ...(sun === undefined ? {} : { sun }),
    ...(design === undefined ? {} : { design }),
    ...skyParams(p),
  };
}

/** The parameters of a shot list (FLR-T-13.10), as the api writes them. */
export interface ShotsParams {
  /** The saved views to render, by ID; default every one. */
  readonly views?: readonly string[];
  readonly size: ShotSize;
  readonly quality: Quality;
  readonly design?: Record<string, string>;
}

export function shotsParams(raw: unknown): ShotsParams {
  const p = (raw ?? {}) as Record<string, unknown>;
  const views = Array.isArray(p['views']) && p['views'].every((v) => typeof v === 'string') ? (p['views']) : undefined;
  const size = typeof p['size'] === 'string' && Object.hasOwn(SHOT_SIZES, p['size']) ? (p['size'] as ShotSize) : 'medium';
  const quality = typeof p['quality'] === 'string' && Object.hasOwn(QUALITIES, p['quality']) ? (p['quality'] as Quality) : 'standard';
  if (!shotWithinBudget(size, quality)) throw new RangeError(`a ${size} shot at ${quality} quality is more work than a still may take`);
  const design = designOf(p['design']);
  return { ...(views === undefined ? {} : { views }), size, quality, ...(design === undefined ? {} : { design }) };
}

/** The parameters of a matched pair (FLR-T-14.4), as the api writes them: B, the camera, the size and quality. */
export interface PairParams {
  readonly design?: Record<string, string>;
  readonly aLabel: string;
  readonly b: { readonly hash: string; readonly label: string; readonly design?: Record<string, string> };
  readonly view?: string;
  readonly camera?: Preset;
  readonly shot?: Record<string, unknown>;
  readonly size: ShotSize;
  readonly quality: Quality;
}

export function pairParams(raw: unknown): PairParams {
  const p = (raw ?? {}) as Record<string, unknown>;
  const b = p['pair'];
  if (!isRecord(b) || typeof b['hash'] !== 'string' || !/^[0-9a-f]{64}$/.test(b['hash'])) throw new RangeError('a pair job names its B');
  const size = typeof p['size'] === 'string' && Object.hasOwn(SHOT_SIZES, p['size']) ? (p['size'] as ShotSize) : 'small';
  const quality = typeof p['quality'] === 'string' && Object.hasOwn(QUALITIES, p['quality']) ? (p['quality'] as Quality) : 'draft';
  if (!shotWithinBudget(size, quality)) throw new RangeError(`a ${size} pair at ${quality} quality is more work than a still may take`);
  const camera = typeof p['camera'] === 'string' && (PRESETS as readonly string[]).includes(p['camera']) ? (p['camera'] as Preset) : undefined;
  const view = typeof p['view'] === 'string' && p['view'] !== '' ? p['view'] : undefined;
  const shot = isRecord(p['shot']) ? p['shot'] : undefined;
  const design = designOf(p['design']);
  const bDesign = designOf(b['design']);
  return {
    ...(design === undefined ? {} : { design }),
    aLabel: typeof p['aLabel'] === 'string' ? p['aLabel'] : 'A',
    b: { hash: b['hash'], label: typeof b['label'] === 'string' ? b['label'] : 'B', ...(bDesign === undefined ? {} : { design: bDesign }) },
    ...(view === undefined ? {} : { view }),
    ...(camera === undefined ? {} : { camera }),
    ...(shot === undefined ? {} : { shot }),
    size,
    quality,
  };
}

/** The parameters of a film (FLR-T-14.1), as the api writes them. */
export interface FilmParams {
  /** The film's ID (the api found it by ID or name). */
  readonly film: string;
  readonly quality: FilmQuality;
  readonly format: FilmFormat;
  readonly size: FilmSize;
  readonly fps: FilmRate;
  readonly light: FilmLight;
  readonly timelapse?: Timelapse;
  readonly design?: Record<string, string>;
}

export function filmParams(raw: unknown): FilmParams {
  const p = (raw ?? {}) as Record<string, unknown>;
  const pick = <T extends string | number>(v: unknown, of: readonly T[], d: T): T => ((of as readonly unknown[]).includes(v) ? (v as T) : d);
  const film = typeof p['film'] === 'string' && p['film'] !== '' ? p['film'] : undefined;
  if (film === undefined) throw new RangeError('a film job names its film');
  const t = p['timelapse'];
  let timelapse: Timelapse | undefined;
  if (isRecord(t) && typeof t['date'] === 'string' && typeof t['from'] === 'string' && typeof t['to'] === 'string') {
    const plan = { date: t['date'], from: t['from'], to: t['to'], lightsAtDusk: t['lightsAtDusk'] !== false };
    if (timelapseProblem(plan) === null) timelapse = plan;
  }
  const design = designOf(p['design']);
  return {
    film,
    quality: pick(p['quality'], FILM_QUALITIES, 'draft'),
    format: pick(p['format'], FILM_FORMATS, 'mp4'),
    size: pick(p['size'], Object.keys(FILM_SIZES) as FilmSize[], '1080p'),
    fps: pick(p['fps'], FILM_RATES, 30),
    light: pick(p['light'], FILM_LIGHTS, 'timeline'),
    ...(timelapse === undefined ? {} : { timelapse }),
    ...(design === undefined ? {} : { design }),
  };
}

/**
 * A shot list's ZIP (FLR-T-13.10): each still a PNG named for its place and its view —
 * `01-hero-exterior.png` — and what each shot was, for the job's summary.
 */
export function shotsZip(shots: readonly Shot[]): { bytes: Uint8Array; shots: Record<string, unknown>[] } {
  const names = new Set<string>();
  const files = shots.map(({ view, still }, i) => {
    let name = `${String(i + 1).padStart(2, '0')}-${slug(view.name)}.png`;
    while (names.has(name)) name = name.replace(/\.png$/, '-2.png');
    names.add(name);
    return { name, view, still };
  });
  return {
    bytes: storeZip(files.map((f) => ({ name: f.name, bytes: f.still.png }))),
    shots: files.map((f) => ({
      file: f.name,
      view: f.view.id,
      name: f.view.name,
      width: f.still.width,
      height: f.still.height,
      samples: f.still.samples,
      ...(f.still.lit?.exposure === undefined ? {} : { exposure: f.still.lit.exposure }),
      ...(f.still.sky === undefined ? {} : { sky: f.still.sky }),
      ms: f.still.ms,
    })),
  };
}

/** A file name's safe form: "Courtyard at dusk" → "courtyard-at-dusk". */
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'view';

/** Only the images the job's project claimed (FLR-T-8.2). */
function claimedOnly(job: JobRow, source: ImageSource | undefined): ImageSource | undefined {
  const claimed = job.claimed;
  return source === undefined || claimed === undefined ? source : (asset) => (claimed.has(asset.sha256) ? source(asset) : undefined);
}

/**
 * The 3D exports' options: one version, its levels, its design, and the asset store's maps and
 * fallback models when the worker can read them — only files the job's project claimed.
 */
function modelOptions(job: JobRow, store: { images: ImageSource | undefined; models: ImageSource | undefined }) {
  const p = exportParams(job.params);
  const claimed = job.claimed;
  const only = (source: ImageSource | undefined): ImageSource | undefined => (source === undefined || claimed === undefined ? source : (asset) => (claimed.has(asset.sha256) ? source(asset) : undefined));
  const images = only(store.images);
  const models = only(store.models);
  return {
    version: { hash: job.versionHash, seq: p.versionSeq ?? null },
    ...(p.levels === undefined ? {} : { levels: p.levels }),
    ...(p.design === undefined ? {} : { design: p.design }),
    ...(p.doors === undefined ? {} : { doors: p.doors }),
    ...(p.lighting === undefined ? {} : { lighting: p.lighting }),
    ...(images === undefined ? {} : { images }),
    ...(models === undefined ? {} : { models }),
  };
}

function options(job: JobRow) {
  const p = exportParams(job.params);
  return {
    version: { hash: job.versionHash, seq: p.versionSeq ?? null, at: new Date(p.versionAt) },
    ...(p.levels === undefined ? {} : { levels: p.levels }),
    ...(p.page === undefined ? {} : { page: p.page }),
    ...(p.design === undefined ? {} : { design: p.design }),
    ...(p.mode === undefined ? {} : { mode: p.mode }),
    ...(p.layers === undefined ? {} : { layers: p.layers }),
    ...(p.style === undefined ? {} : { style: p.style }),
    ...(p.renovation === undefined ? {} : { renovation: p.renovation }),
  };
}

export interface HandlerOptions {
  /**
   * The asset store's directory (`ASSET_DIR`, content-addressed `ab/cd/<sha256>`): glTF and USDZ
   * exports embed the PNG and JPEG maps they find there, and glTF merges fallback models' binaries. The worker mounts the api's volume
   * read-only; without it, exports carry colours and list the maps they left out.
   */
  readonly assetDir?: string;
}

/** The job table, reading maps from `assetDir` when it is given. */
export function createHandlers(opts: HandlerOptions = {}): Readonly<Record<string, Handler>> {
  const store = { images: assetDirImages(opts.assetDir), models: assetDirModels(opts.assetDir) };
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
      const file = await exportGltf(document, modelOptions(job, store));
      return { name: file.name, contentType: file.contentType, bytes: file.bytes, summary: file.summary };
    },
    'export.usdz': async (document, job) => {
      const file = await exportUsdz(document, modelOptions(job, store));
      return { name: file.name, contentType: file.contentType, bytes: file.bytes, summary: file.summary };
    },
    /**
     * FLR-T-12.6: a path-traced still of a view, rendered offline — approximate lighting, a sun and a
     * clear sky — reporting each pass as it goes. Downloaded like an export.
     */
    'export.still': async (document, job) => {
      const p = stillParams(job.params);
      const images = claimedOnly(job, store.images);
      const r = await renderStill(document, {
        ...p,
        ...(images === undefined ? {} : { images }),
        ...(job.progress === undefined ? {} : { onPass: (done: number, total: number) => job.progress?.({ pass: done, passes: total }) }),
      });
      const view = p.room ?? p.camera ?? 'sw';
      return {
        name: `still-${view.replace(/[^\w-]/g, '_')}-${job.versionHash.slice(0, 8)}.png`,
        contentType: 'image/png',
        bytes: r.png,
        summary: {
          label: 'Offline path-traced render — approximate lighting',
          width: r.width,
          height: r.height,
          samples: r.samples,
          size: p.size,
          quality: p.quality,
          camera: r.camera,
          sun: r.sun,
          ...(r.sky === undefined ? {} : { sky: r.sky }),
          design: r.design,
          maps: r.maps,
          ms: r.ms,
        },
      };
    },
    /**
     * FLR-T-13.10: a shot list — every saved view (FS_views), or those named, path-traced as a still,
     * one after another — as one ZIP of PNGs, each named for its view. Reports the shot and the pass.
     */
    'export.shots': async (document, job) => {
      const p = shotsParams(job.params);
      const images = claimedOnly(job, store.images);
      const shots = await renderShots(document, {
        ...(p.views === undefined ? {} : { views: p.views }),
        size: p.size,
        quality: p.quality,
        ...(p.design === undefined ? {} : { design: p.design }),
        ...(images === undefined ? {} : { images }),
        ...(job.progress === undefined ? {} : { onShot: (shot: number, of: number, pass: number, passes: number) => job.progress?.({ shot: shot + 1, shots: of, pass, passes }) }),
      });
      const zip = shotsZip(shots);
      return {
        name: `shots-${job.versionHash.slice(0, 8)}.zip`,
        contentType: 'application/zip',
        bytes: zip.bytes,
        summary: { label: 'Shot list — every saved view, path-traced', size: p.size, quality: p.quality, shots: zip.shots, design: shots[0]?.still.design ?? null },
      };
    },
    /**
     * FLR-T-14.4: a matched pair — A (the job's version) and B (another, read from the store) in their
     * designs, path-traced through one camera, as one ZIP: both pictures, swiped and side by side.
     */
    'export.pair': async (document, job) => {
      const p = pairParams(job.params);
      if (job.load === undefined) throw new Error('this worker cannot read B\'s version');
      const other = await job.load(p.b.hash);
      const images = claimedOnly(job, store.images);
      const r = await renderPair(
        { document, label: p.aLabel, ...(p.design === undefined ? {} : { design: p.design }) },
        { document: other, label: p.b.label, ...(p.b.design === undefined ? {} : { design: p.b.design }) },
        {
          ...(p.view === undefined ? {} : { view: p.view }),
          ...(p.shot === undefined ? {} : { shot: p.shot }),
          ...(p.camera === undefined ? {} : { camera: p.camera }),
          size: p.size,
          quality: p.quality,
          ...(images === undefined ? {} : { images }),
          ...(job.progress === undefined ? {} : { onShot: (shot: number, of: number, pass: number, passes: number) => job.progress?.({ shot: shot + 1, shots: of, pass, passes }) }),
        },
      );
      const files = { a: `a-${slug(p.aLabel)}.png`, b: `b-${slug(p.b.label)}.png`, swipe: 'swipe.png', sideBySide: 'side-by-side.png' };
      return {
        name: `pair-${slug(p.aLabel)}-vs-${slug(p.b.label)}-${job.versionHash.slice(0, 8)}.zip`,
        contentType: 'application/zip',
        bytes: storeZip([
          { name: files.a, bytes: r.a.png },
          { name: files.b, bytes: r.b.png },
          { name: files.swipe, bytes: r.swipe },
          { name: files.sideBySide, bytes: r.sideBySide },
        ]),
        summary: {
          label: 'Matched pair — A and B path-traced from one camera',
          pair: { a: { label: p.aLabel, file: files.a, design: r.a.design }, b: { label: p.b.label, file: files.b, design: r.b.design }, swipe: files.swipe, sideBySide: files.sideBySide, camera: r.camera },
          width: r.width,
          height: r.height,
          samples: r.a.samples,
          size: p.size,
          quality: p.quality,
          ms: r.ms,
        },
      };
    },
    /**
     * FLR-T-14.1: a film — the document's camera path, drawn (a draft) or path-traced (a final) frame
     * by frame and encoded as MP4 or WebM. Reports the frames done, the clock in a timelapse, and now
     * and then a small picture of the frame just made.
     */
    'export.film': async (document, job) => {
      const p = filmParams(job.params);
      const images = claimedOnly(job, store.images);
      const r = await renderFilm(document, {
        ...p,
        ...(images === undefined ? {} : { images }),
        // On the film thread the maps are read from the store again, still only those the project claimed.
        ...(opts.assetDir === undefined ? {} : { assets: { dir: opts.assetDir, ...(job.claimed === undefined ? {} : { claimed: [...job.claimed] }) } }),
        ...(job.progress === undefined ? {} : { onFrame: (f) => job.progress?.({ ...f }) }),
        ...(job.signal === undefined ? {} : { signal: job.signal }),
      });
      return {
        name: `film-${slug(r.film.name)}-${job.versionHash.slice(0, 8)}.${r.format}`,
        contentType: r.contentType,
        bytes: r.bytes,
        summary: {
          label: r.quality === 'final' ? 'Film — path-traced frame by frame, denoised' : 'Film — a draft, drawn by the rasterizer',
          film: r.film,
          quality: r.quality,
          format: r.format,
          width: r.width,
          height: r.height,
          fps: r.fps,
          frames: r.frames,
          seconds: r.seconds,
          ...(r.samples === undefined ? {} : { samples: r.samples }),
          light: r.light,
          ...(r.timelapse === undefined ? {} : { timelapse: r.timelapse }),
          ...(r.video === null ? {} : { codec: r.video.codec }),
          design: r.design,
          ms: r.ms,
        },
      };
    },
    /**
     * FLR-T-8.5: a PNG of the 3D model from a named view or a room; the api waits for it. With
     * `lights` (FLR-T-12.22), path-traced with the luminaires on or off instead of rasterized.
     */
    'render.3d': async (document, job) => {
      const p = render3dParams(job.params);
      const images = claimedOnly(job, store.images);
      // FLR-T-14.4: a changeset (the job's version) against main, side by side from one camera.
      if (p.compare !== undefined) {
        if (job.load === undefined) throw new Error('this worker cannot read main\'s version');
        const main = await job.load(p.compare.hash);
        const c = await render3dCompare(
          { document: main, ...(p.compare.design === undefined ? {} : { design: p.compare.design }) },
          { document, ...(p.design === undefined ? {} : { design: p.design }), ...(p.highlight === undefined ? {} : { highlight: p.highlight }) },
          {
            ...(p.camera === undefined ? {} : { camera: p.camera }),
            ...(p.room === undefined ? {} : { room: p.room }),
            ...(p.level === undefined ? {} : { level: p.level }),
            ...(p.width === undefined ? {} : { width: p.width }),
            ...(p.doors === undefined ? {} : { doors: p.doors }),
            ...(p.sky === undefined ? {} : { sky: p.sky }),
            ...(p.at === undefined ? {} : { at: p.at }),
            ...(images === undefined ? {} : { images }),
          },
        );
        return { name: `compare-${job.versionHash.slice(0, 8)}.png`, contentType: 'image/png', bytes: c.png, summary: { width: c.width, height: c.height, camera: c.camera, design: c.design } };
      }
      // FLR-T-13.10: a saved view, as the photograph it describes.
      if (p.view !== undefined) {
        const shot = await renderSavedView(document, p.view, {
          ...(p.width === undefined ? {} : { width: p.width }),
          ...(p.design === undefined ? {} : { design: p.design }),
          ...(p.doors === undefined ? {} : { doors: p.doors }),
          ...(images === undefined ? {} : { images }),
        });
        return { name: `render-${slug(shot.view.name)}-${job.versionHash.slice(0, 8)}.png`, contentType: 'image/png', bytes: shot.png, summary: { width: shot.width, height: shot.height, camera: shot.camera, view: { id: shot.view.id, name: shot.view.name }, design: shot.design, ...(shot.lit === undefined ? {} : { lit: shot.lit }), ...(shot.sky === undefined ? {} : { sky: shot.sky }), ms: shot.ms } };
      }
      if (p.lights !== undefined) {
        const lit = await renderLit(document, {
          lights: p.lights,
          ...(p.time === undefined ? {} : { time: p.time }),
          ...(p.sky === undefined ? {} : { sky: p.sky }),
          ...(p.at === undefined ? {} : { at: p.at }),
          ...(p.camera === undefined ? {} : { camera: p.camera }),
          ...(p.room === undefined ? {} : { room: p.room }),
          ...(p.level === undefined ? {} : { level: p.level }),
          ...(p.width === undefined ? {} : { width: p.width }),
          ...(p.design === undefined ? {} : { design: p.design }),
          ...(p.doors === undefined ? {} : { doors: p.doors }),
          ...(p.lighting === undefined ? {} : { lighting: p.lighting }),
          ...(p.scene === undefined ? {} : { scene: p.scene }),
          ...(images === undefined ? {} : { images }),
        });
        return { name: `render-${job.versionHash.slice(0, 8)}.png`, contentType: 'image/png', bytes: lit.png, summary: { width: lit.width, height: lit.height, camera: lit.camera, design: lit.design, ...(lit.lit === undefined ? {} : { lit: lit.lit }), ...(lit.sky === undefined ? {} : { sky: lit.sky }), ms: lit.ms } };
      }
      // A material with a map and no colour is drawn in its map's average colour (FLR-T-12.23).
      const r = await render3dPng(document, { ...p, ...(images === undefined ? {} : { images }) });
      return { name: `render-${job.versionHash.slice(0, 8)}.png`, contentType: 'image/png', bytes: r.png, summary: { width: r.width, height: r.height, camera: r.camera, design: r.design, ...(r.sky === undefined ? {} : { sky: r.sky }) } };
    },
  };
}

/** The job table of this process: maps from `ASSET_DIR` when it is set. */
export const handlers: Readonly<Record<string, Handler>> = createHandlers({ ...(process.env['ASSET_DIR'] === undefined ? {} : { assetDir: process.env['ASSET_DIR'] }) });
