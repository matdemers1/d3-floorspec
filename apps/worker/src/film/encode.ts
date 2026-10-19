/**
 * A film's frames into a video (FLR-T-14.1): raw RGB piped to ffmpeg — H.264 in MP4, or VP9 in
 * WebM — in its own process (FLR-ADR-051: Debian's ffmpeg in the worker image, aggregated rather
 * than linked). The file is written to a temporary directory, so MP4's index can be moved to the
 * front (`+faststart`) and a browser plays it as it downloads, then read back and removed.
 *
 * `describeVideo` reads a file's container and codec from its own bytes — the boxes of an MP4, the
 * EBML header and track of a WebM — so a test, and the job's summary, can say what was made without
 * ffprobe.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FilmFormat, FilmQuality } from './presets.js';

/** The ffmpeg to run: `FFMPEG_PATH`, or the one on the PATH. */
export const ffmpegPath = (): string => process.env['FFMPEG_PATH'] ?? 'ffmpeg';

/** Whether ffmpeg runs here, and encodes both codecs a film is made in. */
export function ffmpegReady(): boolean {
  const r = spawnSync(ffmpegPath(), ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 15_000 });
  return r.status === 0 && /libx264/.test(r.stdout) && /libvpx-vp9/.test(r.stdout);
}

export interface EncoderOptions {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly format: FilmFormat;
  /** A draft is encoded fast; a final, more carefully — its frames took far longer than the encoding will. */
  readonly quality: FilmQuality;
  /** The film's name, in the file's metadata. */
  readonly title?: string;
}

export interface Encoder {
  /** One frame: RGB, eight bits a channel, rows top to bottom. Resolves when ffmpeg can take another. */
  write(rgb: Uint8Array): Promise<void>;
  /** The video, once every frame is written. */
  finish(): Promise<Uint8Array>;
  /** Stop, and throw the file away. */
  abort(): Promise<void>;
}

function codecArgs(o: EncoderOptions): string[] {
  // BT.709, as HD video is: the frames are sRGB, whose primaries those are.
  const colour = ['-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
  if (o.format === 'mp4') return ['-c:v', 'libx264', '-preset', o.quality === 'final' ? 'slow' : 'veryfast', '-crf', '18', ...colour, '-tag:v', 'avc1', '-movflags', '+faststart'];
  return ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '31', '-row-mt', '1', '-deadline', 'good', '-cpu-used', o.quality === 'final' ? '2' : '5', ...colour];
}

/** Start ffmpeg for a film. */
export async function startEncoder(o: EncoderOptions): Promise<Encoder> {
  if (o.width % 2 !== 0 || o.height % 2 !== 0) throw new RangeError('a film’s frame is an even number of pixels each way');
  const dir = await mkdtemp(join(tmpdir(), 'floorspec-film-'));
  const out = join(dir, `film.${o.format}`);
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-nostdin',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    '-s', `${String(o.width)}x${String(o.height)}`,
    '-r', String(o.fps),
    '-i', 'pipe:0',
    ...codecArgs(o),
    '-r', String(o.fps),
    ...(o.title === undefined ? [] : ['-metadata', `title=${o.title.replace(/[\r\n]/g, ' ').slice(0, 200)}`]),
    '-y', out,
  ];
  const child = spawn(ffmpegPath(), args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => {
    stderr = (stderr + d).slice(-4000);
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on('error', (error) => { reject(new Error(`ffmpeg could not be started (${error.message}): the worker image installs it; elsewhere set FFMPEG_PATH`)); });
    child.on('close', (code) => { resolve(code); });
  });
  // An early exit (a bad argument, a full disk) fails the next write rather than hanging it.
  let failed: Error | null = null;
  // Read through a function: the callbacks set it while a write is awaited.
  const failure = (): Error | null => failed;
  exited.then(
    (code) => { if (code !== 0) failed ??= new Error(`ffmpeg stopped (${String(code)}): ${stderr.trim().split('\n').slice(-3).join(' ') || 'no reason given'}`); },
    (error: unknown) => { failed ??= error instanceof Error ? error : new Error(String(error)); },
  );
  child.stdin.on('error', () => undefined);
  const frameBytes = o.width * o.height * 3;
  const cleanup = () => rm(dir, { recursive: true, force: true });
  return {
    async write(rgb) {
      const before = failure();
      if (before !== null) throw before;
      if (rgb.byteLength !== frameBytes) throw new RangeError(`a frame is ${String(frameBytes)} bytes; this one is ${String(rgb.byteLength)}`);
      const more = child.stdin.write(rgb);
      if (!more)
        await new Promise<void>((resolve) => {
          const go = () => {
            child.stdin.off('drain', go);
            child.off('close', go);
            resolve();
          };
          child.stdin.on('drain', go);
          child.on('close', go);
        });
      const after = failure();
      if (after !== null) throw after;
    },
    async finish() {
      child.stdin.end();
      try {
        const code = await exited;
        if (code !== 0) throw failure() ?? new Error(`ffmpeg stopped (${String(code)})`);
        return new Uint8Array(await readFile(out));
      } finally {
        await cleanup();
      }
    },
    async abort() {
      child.stdin.destroy();
      child.kill('SIGKILL');
      await exited.catch(() => undefined);
      await cleanup();
    },
  };
}

// ─── What a file is ──────────────────────────────────────────────────────────────────────────

export interface VideoFacts {
  readonly container: 'mp4' | 'webm';
  readonly codec: 'h264' | 'vp9' | 'vp8' | 'unknown';
  /** MP4: its top-level boxes, in order. */
  readonly boxes?: readonly string[];
  /** Seconds, when the file says. */
  readonly seconds?: number;
}

const ascii = (b: Uint8Array, at: number, n: number): string => String.fromCharCode(...b.subarray(at, at + n));

function indexOf(b: Uint8Array, text: string, from = 0, to = b.length): number {
  const codes = Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
  outer: for (let i = from; i <= Math.min(to, b.length) - codes.length; i++) {
    for (let j = 0; j < codes.length; j++) if (b[i + j] !== codes[j]) continue outer;
    return i;
  }
  return -1;
}

/** The container and codec of a film, read from its bytes; null when it is neither an MP4 nor a WebM. */
export function describeVideo(bytes: Uint8Array): VideoFacts | null {
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') {
    const boxes: string[] = [];
    let seconds: number | undefined;
    let codec: VideoFacts['codec'] = 'unknown';
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let at = 0; at + 8 <= bytes.length; ) {
      let size = view.getUint32(at);
      const type = ascii(bytes, at + 4, 4);
      if (size === 1 && at + 16 <= bytes.length) size = Number(view.getBigUint64(at + 8));
      else if (size === 0) size = bytes.length - at;
      if (size < 8) break;
      boxes.push(type);
      if (type === 'moov') {
        if (indexOf(bytes, 'avc1', at, at + size) >= 0) codec = 'h264';
        const mvhd = indexOf(bytes, 'mvhd', at, at + size);
        if (mvhd >= 0) {
          const version = bytes[mvhd + 4];
          const scale = view.getUint32(mvhd + (version === 1 ? 24 : 16));
          const duration = version === 1 ? Number(view.getBigUint64(mvhd + 28)) : view.getUint32(mvhd + 20);
          if (scale > 0) seconds = duration / scale;
        }
      }
      at += size;
    }
    return { container: 'mp4', codec, boxes, ...(seconds === undefined ? {} : { seconds }) };
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    if (indexOf(bytes, 'webm', 0, 64) < 0) return null;
    const head = Math.min(bytes.length, 1 << 16);
    const codec = indexOf(bytes, 'V_VP9', 0, head) >= 0 ? 'vp9' : indexOf(bytes, 'V_VP8', 0, head) >= 0 ? 'vp8' : 'unknown';
    return { container: 'webm', codec };
  }
  return null;
}
