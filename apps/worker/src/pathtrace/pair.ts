/**
 * Matched pairs (FLR-T-14.4, FLR-ADR-054): two designs — A and B: main and a pending changeset,
 * two options of an option set, two versions — path-traced through one camera, so every pixel of
 * one lines up with the same place in the other, and composited two ways: swiped at the middle (A's
 * left half beside B's right half, a divider between) and side by side.
 *
 * The camera is one of three: a saved view (FS_views) — the photograph it describes, with its lens,
 * frame, cutaway, sky and lights; `shot`, a view as FS_views records one — the editor's camera as
 * it is; or a named view (`sw` …), framed once on both houses together so neither is cut off. It is
 * the shot list's pipeline (views.ts): the same scenes, the same tracer, the same sizes and qualities.
 */
import { buildScene, type Scene } from '../export/gltf/scene.js';
import type { ImageSource } from '../export/gltf/glb.js';
import { pictureSize, readView, type SavedView } from '@floorspec/mesh';
import { presetCamera, type Preset } from '../render3d/camera.js';
import { encodePng } from '../render3d/png.js';
import { sideBySideComposite, swipeComposite } from '../render3d/composite.js';
import { ptScene, renderSceneStill, type StillResult } from './index.js';
import { BUDGET_MS, QUALITIES, SHOT_SIZES, shotWithinBudget, type Quality, type ShotSize } from './presets.js';
import { resolveSky } from './sky.js';
import { sceneFor, shoot, viewOf } from './views.js';

export { GAP, sideBySideComposite, swipeComposite } from '../render3d/composite.js';

/** A side of the pair: its document, the design it is drawn in, and what it is in words. */
export interface PairSide {
  readonly document: object;
  readonly design?: Record<string, string>;
  readonly label: string;
}

export interface PairOptions {
  /** A saved view by its ID or name, looked for in A's document, then B's. */
  readonly view?: string;
  /** A view as FS_views records one: the editor's camera. */
  readonly shot?: Record<string, unknown>;
  /** A named view, framed on both houses. Default `sw` when neither a view nor a shot is given. */
  readonly camera?: Preset;
  readonly size?: ShotSize;
  readonly quality?: Quality;
  readonly images?: ImageSource;
  /** Override the long side and the samples a pixel (tests). */
  readonly long?: number;
  readonly samples?: number;
  /** Called as each side starts (shot 0 is A, 1 is B) and as its passes go. */
  readonly onShot?: (shot: number, shots: number, pass: number, passes: number) => void | Promise<void>;
}

export interface PairResult {
  readonly a: StillResult;
  readonly b: StillResult;
  /** A's left half and B's right half, a divider between. */
  readonly swipe: Uint8Array;
  /** A and B side by side. */
  readonly sideBySide: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** The camera, in words: a view's name, or "SW iso". */
  readonly camera: string;
  readonly ms: number;
}

/** What a scene draws, metres in the scene's frame: the box a named view frames. */
function boxOf(scene: Scene): { min: [number, number, number]; max: [number, number, number] } | null {
  const pt = ptScene(scene, { plate: false });
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pt.count * 9; i += 3)
    for (let c = 0; c < 3; c++) {
      const v = pt.positions[i + c] ?? 0;
      if (v < (min[c] ?? Infinity)) min[c] = v;
      if (v > (max[c] ?? -Infinity)) max[c] = v;
    }
  return Number.isFinite(min[0]) ? { min, max } : null;
}

/** The saved view or shot a pair is seen through, or undefined for a named view. */
function pairView(a: PairSide, b: PairSide, options: PairOptions): SavedView | undefined {
  if (options.view !== undefined) {
    try {
      return viewOf(a.document, options.view);
    } catch (error) {
      try {
        return viewOf(b.document, options.view);
      } catch {
        throw error;
      }
    }
  }
  if (options.shot !== undefined) {
    const view = readView('shot', options.shot);
    if (view === undefined) throw new RangeError('a shot is a view as FS_views records one: a name, an eye and a target in base units');
    return view;
  }
  return undefined;
}

/** Path-trace A and B through one camera, and composite them. */
export async function renderPair(a: PairSide, b: PairSide, options: PairOptions = {}): Promise<PairResult> {
  const started = Date.now();
  const size = options.size ?? 'small';
  const quality = options.quality ?? 'draft';
  if (!Object.hasOwn(SHOT_SIZES, size)) throw new RangeError(`size is one of ${Object.keys(SHOT_SIZES).join(', ')}`);
  if (!Object.hasOwn(QUALITIES, quality)) throw new RangeError(`quality is one of ${Object.keys(QUALITIES).join(', ')}`);
  if (!shotWithinBudget(size, quality)) throw new RangeError(`a ${size} pair at ${quality} quality is more work than a still may take`);
  const long = options.long ?? SHOT_SIZES[size];
  const samples = options.samples ?? QUALITIES[quality];
  const view = pairView(a, b, options);
  const sides = [a, b] as const;
  const stills: StillResult[] = [];
  if (view !== undefined) {
    for (const [i, side] of sides.entries()) {
      const opts = { ...(side.design === undefined ? {} : { design: side.design }), ...(options.images === undefined ? {} : { images: options.images }) };
      const scene = await sceneFor(side.document, view, opts);
      await options.onShot?.(i, 2, 0, samples);
      stills.push(await shoot(side.document, scene, view, long, samples, BUDGET_MS, { ...opts, rgb: true, onPass: (done, total) => options.onShot?.(i, 2, done, total) }));
    }
  } else {
    const scenes = await Promise.all(sides.map((s) => buildScene(s.document, { ...(s.design === undefined ? {} : { design: s.design }), ...(options.images === undefined ? {} : { images: options.images }) })));
    // One camera framed on both houses together: what either adds stays in the picture.
    const boxes = scenes.map(boxOf).filter((x) => x !== null);
    const box = boxes.length === 0 ? { min: [0, 0, 0] as [number, number, number], max: [0, 0, 0] as [number, number, number] } : boxes.reduce((u, x) => ({ min: [Math.min(u.min[0], x.min[0]), Math.min(u.min[1], x.min[1]), Math.min(u.min[2], x.min[2])], max: [Math.max(u.max[0], x.max[0]), Math.max(u.max[1], x.max[1]), Math.max(u.max[2], x.max[2])] }));
    const [width, height] = pictureSize(long, '3:2');
    const camera = presetCamera(options.camera ?? 'sw', box, width / height);
    const site = (a.document as { site?: { trueNorth?: unknown } }).site;
    const trueNorth = typeof site?.trueNorth === 'number' ? site.trueNorth / 1e6 : 0;
    const skyLight = resolveSky(a.document, {});
    for (const [i, scene] of scenes.entries()) {
      await options.onShot?.(i, 2, 0, samples);
      stills.push(
        await renderSceneStill(scene, {
          shot: { camera, inside: false },
          pixels: { width, height },
          samples,
          budgetMs: BUDGET_MS,
          skyLight,
          trueNorth,
          rgb: true,
          ...(options.images === undefined ? {} : { images: options.images }),
          onPass: (done, total) => options.onShot?.(i, 2, done, total),
        }),
      );
    }
  }
  const [sa, sb] = stills as [StillResult, StillResult];
  if (sa.rgb === undefined || sb.rgb === undefined || sa.width !== sb.width || sa.height !== sb.height) throw new Error('the two pictures did not come out the same size');
  const swipe = encodePng(swipeComposite(sa.rgb, sb.rgb, sa.width, sa.height), sa.width, sa.height);
  const both = sideBySideComposite(sa.rgb, sb.rgb, sa.width, sa.height);
  return { a: sa, b: sb, swipe, sideBySide: encodePng(both.rgb, both.width, both.height), width: sa.width, height: sa.height, camera: sa.camera, ms: Date.now() - started };
}
