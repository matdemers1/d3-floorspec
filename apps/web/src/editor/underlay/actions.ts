import type { EditorStore } from '../store';
import { uploadTexture } from '../../materials/api';
import { visibleRegion } from '../viewport';
import { calibrate, centreOf, initialPlacement, moveBy, replacePlacement, rotateTo } from './transform';
import { underlayOf, type Underlay } from './state';
import type { Point } from '../model';
import type { PdfFile } from './pdf';

/**
 * Importing and working an underlay (FLR-T-18.12): a file picked → an image (a PDF's page drawn in
 * the browser) → a project asset → a placement on the level. Everything after the upload is view
 * data in the underlay store; nothing here applies an Op.
 */

/** What the file picker offers: the image formats the asset store keeps, and PDF. */
export const UNDERLAY_ACCEPT = 'image/png,image/jpeg,image/webp,application/pdf,.png,.jpg,.jpeg,.webp,.pdf';

/** What an image file is, from its first bytes; null when it is not one an underlay may be. */
export function imageKind(head: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 12 && String.fromCharCode(...head.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...head.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

/** A file picked for an underlay: an image as it is, or an opened PDF whose page is still to be chosen. */
export type Picked = { kind: 'image'; file: File } | { kind: 'pdf'; file: File; pdf: PdfFile };

export class UnderlayError extends Error {}

/** Read what a picked file is; a PDF is opened (loading pdf.js the first time). */
export async function readPicked(file: File): Promise<Picked> {
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  const { looksLikePdf, openPdf } = await import('./pdf');
  if (looksLikePdf(head)) {
    try {
      return { kind: 'pdf', file, pdf: await openPdf(await file.arrayBuffer()) };
    } catch (e) {
      throw new UnderlayError(`This PDF could not be read${e instanceof Error && e.message !== '' ? `: ${e.message}` : ''}.`);
    }
  }
  if (imageKind(head) === null) throw new UnderlayError('An underlay is a PNG, JPEG or WebP image, or a PDF.');
  return { kind: 'image', file };
}

/** Where a new image goes on a level: over what is drawn there, or what the view shows of an empty one. */
function frameOf(store: EditorStore): { minX: number; minY: number; maxX: number; maxY: number } {
  const bounds = store.levelView?.bounds ?? null;
  if (bounds !== null) return bounds;
  const view = store.get().view;
  return view === null ? { minX: -1e7, minY: -1e7, maxX: 1e7, maxY: 1e7 } : visibleRegion(view);
}

/**
 * Upload the picked image (or the chosen page of a PDF) and lay it on the level: replacing an
 * underlay keeps its place, its turn and its width on the plan; a new one is centred over the level.
 */
export async function placeUnderlay(store: EditorStore, level: string, picked: Picked, page = 1): Promise<Underlay> {
  let upload: Blob & { name?: string };
  let name = picked.file.name === '' ? null : picked.file.name;
  if (picked.kind === 'pdf') {
    const drawn = await picked.pdf.render(page);
    // The stored file is a PNG of one page: its name says which.
    name = `${(name ?? 'plan.pdf').replace(/\.pdf$/i, '')} — page ${String(page)}.png`;
    upload = Object.assign(drawn.blob, { name });
  } else {
    // A File's name is its own (and read-only).
    upload = picked.file;
  }
  const asset = await uploadTexture(store.projectId, upload);
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(asset.mediaType)) throw new UnderlayError('An underlay is a PNG, JPEG or WebP image, or a PDF.');
  const u = underlayOf(store);
  const before = u.of(level);
  const placement = before === undefined ? initialPlacement(asset.width, asset.height, frameOf(store)) : replacePlacement(before, before.width, asset.width);
  const underlay: Underlay = {
    sha256: asset.sha256,
    name,
    mediaType: asset.mediaType,
    width: asset.width,
    height: asset.height,
    origin: placement.origin,
    scale: placement.scale,
    rotation: placement.rotation,
    opacity: before?.opacity ?? 0.6,
    locked: false,
    state: before?.state === 'off' || before === undefined ? 'on' : before.state,
    ...(picked.kind === 'pdf' ? { page } : {}),
  };
  u.put(level, underlay);
  return underlay;
}

/** The second click of "Set scale" made and a length typed: the underlay calibrated, or why not. */
export function applyScale(store: EditorStore, level: string, a: Point, b: Point, length: number): string | null {
  const u = underlayOf(store);
  const current = u.of(level);
  if (current === undefined) return 'There is no underlay on this level.';
  if (current.locked) return 'The underlay is locked.';
  const next = calibrate(current, a, b, length);
  if (next === null) return a[0] === b[0] && a[1] === b[1] ? 'The two points are the same point: click two points a known length apart.' : 'Type a length longer than zero.';
  u.update(level, { origin: next.origin, scale: next.scale });
  u.begin(null);
  return null;
}

/** The second click of "Move" made: the point of the image clicked first is now where the second click snapped. */
export function applyMove(store: EditorStore, level: string, from: Point, to: Point): void {
  const u = underlayOf(store);
  const current = u.of(level);
  if (current === undefined || current.locked) return;
  u.update(level, { origin: moveBy(current, from, to).origin });
  u.begin(null);
}

/** Turn the underlay to `deg` about its centre. */
export function applyRotation(store: EditorStore, level: string, deg: number): void {
  const u = underlayOf(store);
  const current = u.of(level);
  if (current === undefined || current.locked || !Number.isFinite(deg)) return;
  const next = rotateTo(current, deg, centreOf(current, current.width, current.height));
  u.update(level, { origin: next.origin, rotation: next.rotation });
}
