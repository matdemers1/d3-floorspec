import { ACESFilmicToneMapping, SRGBColorSpace, WebGPURenderer, type PerspectiveCamera, type Scene, type Texture } from 'three/webgpu';
import { OIDNDenoiser, WebGPUPathTracer } from 'three-gpu-pathtracer/webgpu';
import { initUNetFromURL } from 'oidn-web';
import weightsUrl from './oidn/rt_hdr_alb_nrm.tza?url';
import { EXPOSURE_BAND, meteredExposure, toneMappingExposure, TRACE_UNIT, type TimeOfDay } from './sky';

/**
 * The one module that path-traces on the GPU (FLR-T-13.13, FLR-ADR-040): three.js's WebGPU renderer,
 * three-gpu-pathtracer's WebGPUPathTracer (pinned — a 0.0.x library whose API is new, kept behind
 * this file) and Open Image Denoise (oidn-web, with Intel's weights served alongside the editor).
 * It gets a scene ready to trace (scene.ts) and gives back a PNG; nothing else in the editor imports
 * a GPU library, and the editor loads this only when a still is rendered.
 *
 * The picture is its own renderer on its own canvas, not the live 3D view's: traced at the still's
 * size, `samples` a pixel, then denoised. Exposure is metered as the worker meters its stills — key
 * 0.18 on the log-average luminance, held within the time of day's band — once the image has enough
 * samples to say, and the tone curve is applied as the samples are shown, so the meter changes
 * nothing already traced.
 */

export interface TraceProgress {
  readonly phase: 'preparing' | 'tracing' | 'denoising' | 'done';
  /** Samples every pixel has, and the samples asked for. */
  readonly samples: number;
  readonly target: number;
  /** Samples a pixel a second; null until measured. */
  readonly rate: number | null;
}

export interface TraceRequest {
  readonly canvas: HTMLCanvasElement;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly width: number;
  readonly height: number;
  readonly samples: number;
  readonly time: TimeOfDay;
  /** Denoise once traced. Default true. */
  readonly denoise?: boolean;
  readonly onProgress?: (p: TraceProgress) => void;
  readonly signal?: AbortSignal;
}

export interface TraceResult {
  readonly png: Blob;
  /** What the tone curve was given per cd/m². */
  readonly exposure: number;
  readonly denoised: boolean;
  readonly ms: number;
}

/** The light bounces a path may make: enough for a room lit through its windows and off its walls. */
const BOUNCES = 6;
/** Samples a pixel before the exposure is metered: enough for a log-average to settle. */
const METER_AT = 16;
/** Rows read back to meter: spread over the picture, one row each. */
const METER_ROWS = 48;

export class TraceCancelled extends Error {
  constructor() {
    super('the still was cancelled');
    this.name = 'TraceCancelled';
  }
}

/** The log-average luminance of a few rows of the accumulated image (linear, in `TRACE_UNIT`s). */
async function logAverage(renderer: WebGPURenderer, texture: Texture, width: number, height: number): Promise<number | null> {
  const rows = Array.from({ length: Math.min(METER_ROWS, height) }, (_, i) => Math.floor(((i + 0.5) * height) / Math.min(METER_ROWS, height)));
  const target = { textures: [texture] } as unknown as Parameters<WebGPURenderer['readRenderTargetPixelsAsync']>[0];
  let sum = 0;
  let n = 0;
  for (const y of rows) {
    const data = (await renderer.readRenderTargetPixelsAsync(target, 0, y, width, 1)) as Float32Array;
    for (let x = 0; x < width; x++) {
      const l = 0.2126 * (data[4 * x] ?? 0) + 0.7152 * (data[4 * x + 1] ?? 0) + 0.0722 * (data[4 * x + 2] ?? 0);
      if (!Number.isFinite(l)) continue;
      sum += Math.log(1e-4 + Math.max(0, l));
      n++;
    }
  }
  return n === 0 ? null : Math.exp(sum / n);
}

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => { resolve(); }));

/** Path-trace a still on this device's GPU and give back its PNG. Rejects with TraceCancelled when `signal` aborts. */
export async function traceStill(request: TraceRequest): Promise<TraceResult> {
  const { canvas, scene, camera, width, height, samples, time, signal } = request;
  const started = performance.now();
  const say = (p: TraceProgress): void => request.onProgress?.(p);
  say({ phase: 'preparing', samples: 0, target: samples, rate: null });

  const renderer = new WebGPURenderer({ canvas, antialias: false, alpha: false });
  let tracer: WebGPUPathTracer | null = null;
  try {
    await renderer.init();
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.outputColorSpace = SRGBColorSpace;
    // Until it is metered: the geometric middle of the band.
    const band = EXPOSURE_BAND[time];
    let exposure = Math.sqrt(band.min * band.max);
    renderer.toneMappingExposure = toneMappingExposure(exposure * TRACE_UNIT);

    tracer = new WebGPUPathTracer(renderer);
    tracer.synchronizeRenderSize = false;
    tracer.setSize(width, height);
    tracer.dynamicLowRes = false;
    tracer.renderDelay = 0;
    tracer.fadeDuration = 0;
    tracer.minSamples = 1;
    tracer.maxBounces = BOUNCES;
    tracer.maxSamples = samples;
    tracer.multipleImportanceSampling = true;
    const denoise = request.denoise !== false;
    const denoiser = denoise ? new OIDNDenoiser({ initUNetFromURL, auxWeightsUrl: weightsUrl }) : null;
    if (denoiser !== null) tracer.setDenoiser(denoiser);
    tracer.setScene(scene, camera);

    let metered = false;
    let lastPoll = 0;
    let counts = { min: 0, rate: null as number | null };
    for (;;) {
      if (signal?.aborted === true) throw new TraceCancelled();
      tracer.renderSample();
      const now = performance.now();
      if (now - lastPoll > 400) {
        lastPoll = now;
        const c = await tracer.getSampleCountsAsync();
        counts = { min: c.min, rate: c.samplesPerSecond > 0 ? c.samplesPerSecond : null };
        if (!metered && c.min >= Math.min(METER_AT, samples) && tracer.target !== null) {
          metered = true;
          const avg = await logAverage(renderer, tracer.target, width, height).catch(() => null);
          if (avg !== null) {
            exposure = meteredExposure(avg * TRACE_UNIT, time);
            renderer.toneMappingExposure = toneMappingExposure(exposure * TRACE_UNIT);
          }
        }
        const traced = c.min >= samples;
        if (traced && (denoiser === null || denoiser.complete)) break;
        say({ phase: traced ? 'denoising' : 'tracing', samples: Math.min(c.min, samples), target: samples, rate: counts.rate });
      }
      await nextFrame();
    }
    // Shown once more, the denoised picture with its exposure, and read in the same task.
    tracer.renderSample();
    const png = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => { if (b === null) reject(new Error('the canvas gave no picture')); else resolve(b); }, 'image/png');
    });
    say({ phase: 'done', samples, target: samples, rate: counts.rate });
    return { png, exposure, denoised: denoiser !== null, ms: performance.now() - started };
  } finally {
    tracer?.dispose();
    void renderer.dispose();
  }
}
