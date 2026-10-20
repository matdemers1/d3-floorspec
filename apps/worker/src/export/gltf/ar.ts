/**
 * The USDZ export tuned for AR Quick Look (FLR-T-14.3): the house placed on the real lot at true
 * scale, or on a table at 1:50.
 *
 * - **What goes in** — the board's "Include": the levels (as every 3D export takes them), the roofs,
 *   the furniture (FS_furniture), the fixtures and lights (FS_electrical, FS_plumbing,
 *   FS_mechanical), and the lawn and site (FS_landscape: trees and planting, by far the heaviest
 *   part of a house, so left out unless asked for).
 * - **How big** — `true` is 1:1; `table` is 1:50, a scale on the root prim, so the stage stays in
 *   metres (`metersPerUnit = 1`) and a reader still measures the house in its own units.
 * - **How light** — a phone opens the file whole: furniture and fixtures, modelled for a camera a
 *   metre away, are simplified by clustering their vertices on a 1 cm grid (AR's nearest look is a
 *   phone's length off), and every map is at most 2048 px on its long side.
 */
import { Resvg } from '@resvg/resvg-js';
import { imageSize } from '../../pathtrace/textures.js';
import { encodePng } from '../../render3d/png.js';
import type { Scene, SceneNode, ScenePrimitive } from './scene.js';

export const AR_SCALES = ['true', 'table'] as const;
export type ArScale = (typeof AR_SCALES)[number];

/** Model units a metre of house becomes at each scale: true scale, and 1:50 on a table. */
export const SCALE_FACTOR: Readonly<Record<ArScale, number>> = { true: 1, table: 1 / 50 };
/** As a drawing's scale is written. */
export const SCALE_LABEL: Readonly<Record<ArScale, string>> = { true: '1:1', table: '1:50' };

/** What an AR model includes besides its levels: each on unless said otherwise, but the site. */
export interface ArInclude {
  readonly roofs?: boolean;
  readonly furniture?: boolean;
  readonly fixtures?: boolean;
  readonly site?: boolean;
}

export interface ArOptions extends ArInclude {
  readonly scale: ArScale;
}

/** The longest side of a map in the package, pixels: the board's "baked, 2K". */
export const MAX_AR_TEXTURE = 2048;
/** The grid furniture and fixtures are simplified on, metres. */
export const DECIMATE_CELL = 0.01;

const ROOF_PARTS = new Set(['roof', 'roofGable']);

type Group = 'furniture' | 'fixtures' | 'site' | null;

/** Which of the include's groups an element is in; null for the house itself. */
export function groupOf(node: Pick<SceneNode, 'kind' | 'extension'>): Group {
  if (node.kind !== 'extension' || node.extension === undefined) return null;
  if (node.extension.name === 'FS_furniture') return 'furniture';
  if (node.extension.name === 'FS_landscape') return 'site';
  // FS_electrical, FS_plumbing, FS_mechanical — and any other extension's element.
  return 'fixtures';
}

/**
 * The scene as an AR model shows it: the groups left out dropped, roofs off when asked, and what is
 * left of the furniture and fixtures simplified. The scene's bounds are made again from what is kept.
 */
export function arScene(scene: Scene, include: ArInclude = {}): Scene {
  const keep = { roofs: include.roofs ?? true, furniture: include.furniture ?? true, fixtures: include.fixtures ?? true, site: include.site ?? false };
  const levels = scene.levels.map((level) => ({
    ...level,
    nodes: level.nodes.flatMap((node): SceneNode[] => {
      const group = groupOf(node);
      if (group !== null && !keep[group]) return [];
      let primitives = keep.roofs ? node.primitives : node.primitives.filter((p) => !ROOF_PARTS.has(p.part));
      if (group === 'furniture' || group === 'fixtures') primitives = primitives.map((p) => decimate(p, DECIMATE_CELL)).filter((p) => p.indices.length > 0);
      if (primitives.length === 0 && node.primitives.length > 0) return [];
      return [{ ...node, primitives }];
    }),
  }));
  return { ...scene, levels, bounds: boundsOf(levels.flatMap((l) => l.nodes.flatMap((n) => n.primitives))) ?? scene.bounds };
}

function boundsOf(primitives: readonly ScenePrimitive[]): Scene['bounds'] {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const p of primitives)
    for (let i = 0; i < p.positions.length; i += 3)
      for (let k = 0; k < 3; k++) {
        const v = p.positions[i + k]!;
        if (v < min[k]!) min[k] = v;
        if (v > max[k]!) max[k] = v;
      }
  return Number.isFinite(min[0]) ? { min, max } : null;
}

/**
 * Simplify a mesh by vertex clustering: every vertex moves to the mean of the vertices in its cell
 * of a `cell`-metre grid, and the triangles that collapse go. A mesh coarser than the grid comes
 * back as it was (the same object). What is kept is written flat, a normal per face, as the scene
 * draws furniture; a round piece keeps its smooth normals, averaged per cell.
 */
export function decimate(p: ScenePrimitive, cell: number): ScenePrimitive {
  const n = p.positions.length / 3;
  const cellOf = new Int32Array(n);
  const keys = new Map<string, number>();
  const sums: number[] = [];
  for (let v = 0; v < n; v++) {
    const key = `${String(Math.floor(p.positions[3 * v]! / cell))},${String(Math.floor(p.positions[3 * v + 1]! / cell))},${String(Math.floor(p.positions[3 * v + 2]! / cell))}`;
    let c = keys.get(key);
    if (c === undefined) {
      c = keys.size;
      keys.set(key, c);
      sums.push(0, 0, 0, 0);
    }
    cellOf[v] = c;
    sums[4 * c]! += p.positions[3 * v]!;
    sums[4 * c + 1]! += p.positions[3 * v + 1]!;
    sums[4 * c + 2]! += p.positions[3 * v + 2]!;
    sums[4 * c + 3]! += 1;
  }
  // No two vertices of a triangle share a cell anywhere: nothing to gain.
  const tris = p.indices.length / 3;
  const kept: number[] = [];
  const seen = new Set<string>();
  for (let t = 0; t < tris; t++) {
    const a = p.indices[3 * t]!;
    const b = p.indices[3 * t + 1]!;
    const c = p.indices[3 * t + 2]!;
    const ca = cellOf[a]!;
    const cb = cellOf[b]!;
    const cc = cellOf[c]!;
    if (ca === cb || cb === cc || ca === cc) continue;
    // The same three cells the same way round: one triangle drawn twice.
    const r = Math.min(ca, cb, cc);
    const key = r === ca ? `${String(ca)},${String(cb)},${String(cc)}` : r === cb ? `${String(cb)},${String(cc)},${String(ca)}` : `${String(cc)},${String(ca)},${String(cb)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(t);
  }
  if (kept.length === tris && keys.size === n) return p;
  const mean = (c: number, k: number) => sums[4 * c + k]! / sums[4 * c + 3]!;
  // Written indexed again: a corner is shared by the faces that agree on its cell, normal and coordinates.
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] | null = p.uvs === null ? null : [];
  const indices = new Uint32Array(kept.length * 3);
  const corner = new Map<string, number>();
  const q3 = (x: number) => Math.round(x * 1000);
  kept.forEach((t, i) => {
    const corners = [p.indices[3 * t]!, p.indices[3 * t + 1]!, p.indices[3 * t + 2]!];
    const q = corners.map((v) => [mean(cellOf[v]!, 0), mean(cellOf[v]!, 1), mean(cellOf[v]!, 2)] as const);
    // The face's own normal, unless the piece is round.
    const e1 = [q[1]![0] - q[0]![0], q[1]![1] - q[0]![1], q[1]![2] - q[0]![2]];
    const e2 = [q[2]![0] - q[0]![0], q[2]![1] - q[0]![1], q[2]![2] - q[0]![2]];
    let nx = e1[1]! * e2[2]! - e1[2]! * e2[1]!;
    let ny = e1[2]! * e2[0]! - e1[0]! * e2[2]!;
    let nz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    corners.forEach((v, k) => {
      const n = p.smooth === true ? [p.normals[3 * v]!, p.normals[3 * v + 1]!, p.normals[3 * v + 2]!] : [nx, ny, nz];
      const uv = p.uvs === null ? null : [p.uvs[2 * v]!, p.uvs[2 * v + 1]!];
      const key = `${String(cellOf[v])}|${n.map(q3).join(',')}|${uv === null ? '' : uv.map(q3).join(',')}`;
      let at = corner.get(key);
      if (at === undefined) {
        at = positions.length / 3;
        corner.set(key, at);
        positions.push(...q[k]!);
        normals.push(...n);
        if (uvs !== null && uv !== null) uvs.push(...uv);
      }
      indices[3 * i + k] = at;
    });
  });
  return { ...p, positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: uvs === null ? null : Float32Array.from(uvs), indices };
}

/**
 * A map no longer than `max` pixels on its long side: as it is when it already is, else drawn
 * smaller (by resvg, which the worker carries to decode maps) and written as a PNG. Undefined when
 * it is not a PNG or JPEG that can be read.
 */
export function capTexture(bytes: Uint8Array, mediaType: string, max: number = MAX_AR_TEXTURE): { bytes: Uint8Array; mediaType: string } | undefined {
  const size = imageSize(bytes, mediaType);
  if (size === undefined || size.width < 1 || size.height < 1) return undefined;
  if (size.width <= max && size.height <= max) return { bytes, mediaType };
  const scale = max / Math.max(size.width, size.height);
  const width = Math.max(1, Math.round(size.width * scale));
  const height = Math.max(1, Math.round(size.height * scale));
  const href = `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${String(width)}" height="${String(height)}" viewBox="0 0 ${String(width)} ${String(height)}"><image width="${String(width)}" height="${String(height)}" preserveAspectRatio="none" xlink:href="${href}"/></svg>`;
  try {
    const out = new Resvg(svg, { fitTo: { mode: 'original' }, font: { loadSystemFonts: false }, logLevel: 'off' }).render();
    if (out.width !== width || out.height !== height) return undefined;
    const rgba = out.pixels;
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      rgb[3 * i] = rgba[4 * i]!;
      rgb[3 * i + 1] = rgba[4 * i + 1]!;
      rgb[3 * i + 2] = rgba[4 * i + 2]!;
    }
    return { bytes: encodePng(rgb, width, height), mediaType: 'image/png' };
  } catch {
    return undefined;
  }
}
