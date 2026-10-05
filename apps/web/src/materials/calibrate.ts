/**
 * Calibrating a texture and putting it on a surface (FLR-T-8.2, FLR-REQ-117): the arithmetic of the
 * "Calibrate texture" dialog (Figma frame 13b) and the one Ops batch it applies. Pure — no React,
 * no fetch — so it is tested on its own.
 *
 * A person drags across something in the photo whose real size they know — one tile, the photo's
 * whole width — and types how long it is. That fixes the scale (base units per pixel), and with it
 * the real-world size of the whole image: the texture's `size` (Core 18.2), which is what makes a
 * photo of a 12-inch tile the right size on every wall.
 */
import type { FloorspecDocument } from '@floorspec/engine';
import { labelOf, type EditorModel } from '../editor/model';
import { setProperty, type Batch, type BatchBuilder } from '../editor/ops';
import { nextIds } from '../editor/optionOps';
import { setFinishes, withFace, type Face, type Finishes, type Side } from '../editor/finishOps';
import { formatLen, type UnitSystem } from '../editor/units';

type Json = Record<string, unknown>;

/** What the server answers for an upload (apps/server/src/routes/assets.ts). */
export interface UploadedAsset {
  sha256: string;
  mediaType: string;
  byteLength: number;
  width: number;
  height: number;
  name: string | null;
  /** `assets/<sha256>.<ext>`: where the document's asset entry says the file is (Core 18.4). */
  path: string;
  href: string;
}

export type Pt = readonly [number, number];

/** A measured span on the image, in image pixels. */
export interface Span {
  a: Pt;
  b: Pt;
}

export const spanPixels = (s: Span): number => Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);

/** The whole width of an image, along its middle: the span before anyone drags one. */
export const wholeWidth = (width: number, height: number): Span => ({ a: [0, height / 2], b: [width, height / 2] });

/**
 * The real-world size of the whole image, `[w, h]` in base units, from a span of `pixels` that is
 * `length` long: square pixels, so the aspect is the image's. Null when nothing can be said — a
 * span of no length, a length of none. Rounded once, to whole base units (FLR-ADR-004), and never
 * below one.
 */
export function imageSize(width: number, height: number, pixels: number, length: number): [number, number] | null {
  if (!(pixels > 0) || !(length > 0) || !(width > 0) || !(height > 0)) return null;
  const perPixel = length / pixels;
  return [Math.max(1, Math.round(width * perPixel)), Math.max(1, Math.round(height * perPixel))];
}

/** "1 px = 0.024 in" / "1 px = 0.61 mm": the scale, for a person. */
export function scaleText(size: readonly [number, number], width: number, units: UnitSystem): string {
  const perPixel = size[0] / width;
  if (units === 'metric') {
    const mm = perPixel / 1280;
    return `1 px = ${mm >= 10 ? mm.toFixed(1) : mm.toFixed(2)} mm`;
  }
  const inches = perPixel / 32_512;
  return `1 px = ${inches >= 1 ? inches.toFixed(2) : inches.toFixed(3)} in`;
}

/** "12 × 12 in": the size of one tile as a person reads it. */
export function sizeText(size: readonly [number, number], units: UnitSystem): string {
  return `${formatLen(size[0], units)} × ${formatLen(size[1], units)}`;
}

/** The ID of the document's asset for this file, when it has one already: one digest, one asset (18.4). */
export function existingAssetId(document: FloorspecDocument, sha256: string): string | null {
  for (const [id, a] of Object.entries((document.assets ?? {}) as Record<string, Json | undefined>)) if (a?.['sha256'] === sha256 && typeof a['path'] === 'string') return id;
  return null;
}

/** A material name from a file name: no extension, separators as spaces. */
export function nameFromFile(file: string | null): string {
  const base = (file ?? '').replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return base === '' ? 'Texture' : base.slice(0, 120);
}

// ── where it goes ────────────────────────────────────────────────────────────

export type Target =
  | { kind: 'none' }
  | { kind: 'room'; room: string; surface: 'floorFinish' | 'wallFinish' | 'ceilingFinish' }
  | { kind: 'face'; wall: string; side: Side }
  | { kind: 'region'; wall: string; side: Side; index: number };

export interface TargetChoice {
  value: string;
  label: string;
  target: Target;
}

const SURFACE_WORDS: Record<'floorFinish' | 'wallFinish' | 'ceilingFinish', string> = { floorFinish: 'floor', wallFinish: 'walls', ceilingFinish: 'ceiling' };

export function targetKey(t: Target): string {
  switch (t.kind) {
    case 'none':
      return 'none';
    case 'room':
      return `room:${t.room}:${t.surface}`;
    case 'face':
      return `face:${t.wall}:${t.side}`;
    case 'region':
      return `region:${t.wall}:${t.side}:${String(t.index)}`;
  }
}

/**
 * Where a texture can be applied (the dialog's "Apply to"): nowhere yet; each room's floor, walls
 * and ceiling; every region of every wall face — a backsplash, named by the room it faces and its
 * height; and both faces of the selected wall.
 */
export function targetChoices(model: EditorModel, selection: string | null, units: UnitSystem): TargetChoice[] {
  const out: TargetChoice[] = [{ value: 'none', label: 'Nothing yet — add it to the materials', target: { kind: 'none' } }];
  const add = (target: Target, label: string) => out.push({ value: targetKey(target), label, target });
  const regions: TargetChoice[] = [];
  const walls = (model.document.walls ?? {}) as Record<string, Json | undefined>;
  for (const [wid, w] of Object.entries(walls).sort(([a], [b]) => a.localeCompare(b))) {
    const finishes = w?.['finishes'] as Finishes | undefined;
    for (const side of ['left', 'right'] as const) {
      const faced = model.derived?.finishes?.walls[wid]?.[side]?.room;
      (finishes?.[side]?.regions ?? []).forEach((r, index) => {
        const where = faced === undefined ? labelOf(model, wid) : labelOf(model, faced);
        const target: Target = { kind: 'region', wall: wid, side, index };
        regions.push({ value: targetKey(target), target, label: `${where} · region on ${labelOf(model, wid)} (${formatLen(r.top - r.bottom, units)} high)` });
      });
    }
  }
  out.push(...regions);
  if (selection !== null && Object.hasOwn(walls, selection))
    for (const side of ['left', 'right'] as const) {
      const faced = model.derived?.finishes?.walls[selection]?.[side]?.room;
      add({ kind: 'face', wall: selection, side }, `${labelOf(model, selection)} · ${side} face${faced === undefined ? '' : ` (${labelOf(model, faced)})`}`);
    }
  const rooms = Object.keys(model.document.rooms ?? {}).sort((a, b) => labelOf(model, a).localeCompare(labelOf(model, b)));
  for (const room of rooms) for (const surface of ['floorFinish', 'wallFinish', 'ceilingFinish'] as const) add({ kind: 'room', room, surface }, `${labelOf(model, room)} · ${SURFACE_WORDS[surface]}`);
  return out;
}

/**
 * The choice the dialog opens on: a region of the selected wall (the backsplash being finished),
 * else the selected wall's face that faces a room, else the selected room's walls, else nothing.
 */
export function defaultTarget(choices: readonly TargetChoice[], selection: string | null): string {
  if (selection === null) return 'none';
  const region = choices.find((c) => c.target.kind === 'region' && c.target.wall === selection);
  if (region !== undefined) return region.value;
  const room = choices.find((c) => c.target.kind === 'room' && c.target.room === selection && c.target.surface === 'floorFinish');
  if (room !== undefined) return room.value;
  return 'none';
}

/** The ops that make a surface show `material`. */
export function applyOps(document: FloorspecDocument, target: Target, material: string): Batch {
  switch (target.kind) {
    case 'none':
      return [];
    case 'room':
      return setProperty(target.room, `/${target.surface}`, material);
    case 'face':
    case 'region': {
      const w = (document.walls ?? {})[target.wall] as Json | undefined;
      const finishes = w?.['finishes'] as Finishes | undefined;
      const face: Face = finishes?.[target.side] ?? {};
      const next: Face =
        target.kind === 'face'
          ? { ...face, material }
          : { ...face, regions: (face.regions ?? []).map((r, i) => (i === target.index ? { ...r, material } : r)) };
      return setFinishes(target.wall, withFace(finishes, target.side, next));
    }
  }
}

export interface TextureChange {
  asset: UploadedAsset;
  /** The material to re-size; absent: a new one. */
  material?: string;
  name: string;
  /** Its colour where the map is not drawn: the photo's average. */
  color?: string | null;
  size: [number, number];
  /** Thousandths; absent: matte (Core 18.1). */
  roughness?: number | null;
  target: Target;
}

/**
 * One batch, one undo step: the asset — unless the document has this file already — the material
 * (new, or its tile size changed), and the finish that puts it on the surface.
 */
export function textureBatch(model: EditorModel, change: TextureChange): BatchBuilder {
  return (attempt) => {
    const doc = model.document;
    const ops: Batch = [];
    let assetId = existingAssetId(doc, change.asset.sha256);
    if (assetId === null) {
      [assetId] = nextIds(model, 'IMG', 1, attempt) as [string];
      ops.push({
        op: 'addElement',
        collection: 'assets',
        id: assetId,
        element: {
          path: change.asset.path,
          sha256: change.asset.sha256,
          mediaType: change.asset.mediaType,
          byteLength: change.asset.byteLength,
          ...(change.asset.name === null ? {} : { name: change.asset.name.slice(0, 200) }),
        },
      });
    }
    let material = change.material;
    if (material === undefined) {
      [material] = nextIds(model, 'M', 1, attempt) as [string];
      ops.push({
        op: 'addElement',
        collection: 'materials',
        id: material,
        element: {
          name: change.name,
          ...(change.color === undefined || change.color === null ? {} : { color: change.color }),
          ...(change.roughness === undefined || change.roughness === null ? {} : { roughness: change.roughness }),
          texture: { asset: assetId, size: change.size },
        },
      });
    } else {
      const existing = (doc.materials ?? {})[material] as Json | undefined;
      const tex = existing?.['texture'] as Json | undefined;
      ops.push(...(tex === undefined ? setProperty(material, '/texture', { asset: assetId, size: change.size }) : setProperty(material, '/texture/size', change.size)));
      if (tex !== undefined && tex['asset'] !== assetId) ops.push(...setProperty(material, '/texture/asset', assetId));
    }
    ops.push(...applyOps(doc, change.target, material));
    return ops;
  };
}

/** "#rrggbb" of an average of RGBA pixels: a textured material's colour where its map is not drawn. */
export function averageColour(rgba: Uint8ClampedArray | Uint8Array): string | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const a = rgba[i + 3] ?? 0;
    if (a === 0) continue;
    r += rgba[i] ?? 0;
    g += rgba[i + 1] ?? 0;
    b += rgba[i + 2] ?? 0;
    n++;
  }
  if (n === 0) return null;
  const hex = (v: number) => Math.round(v / n).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}
