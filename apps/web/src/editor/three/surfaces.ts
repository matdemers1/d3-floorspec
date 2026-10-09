import { surfaceGroups, tileCoordinates, type HouseMesh, type MeshPart, type SurfaceGroup } from '@floorspec/mesh';
import type { EditorModel } from '../model';
import { DEFAULTS, linear, materialColour } from './parts';

/**
 * Textured surfaces for the 3D view (FLR-T-8.2, Core 0.3 18.3): a wall, floor, ceiling, junction
 * fill or threshold part's triangles as @floorspec/mesh groups them by finished surface — each face,
 * each region cut out of a face (a fill's faces in its walls' planes among them, FLR-T-12.20), a
 * floor, a ceiling — with each group's colour and, where its material has a base colour
 * map, texture coordinates in **world units**: the tile coordinates `(s'/w, t'/h)` of 18.3, so one
 * repeat of the image covers exactly the material's `size` of real surface, region-anchored. No
 * three.js here; the view turns these arrays into a geometry with one draw group per map.
 */

type Json = Record<string, unknown>;

/** A material's base colour map, as the view loads it: the file by its digest, laid by its texture. */
export interface MapRef {
  /** One per material and map: what a three.js material is cached by. */
  key: string;
  material: string;
  sha256: string;
  /** The material's colour, shown until the image arrives (Core 18.1). */
  color: string | null;
}

export interface SurfaceBuffers {
  positions: Float32Array;
  normals: Float32Array;
  /** Linear RGB per vertex: the surface's colour, or white under a map (the map is the colour). */
  colors: Float32Array;
  uvs: Float32Array;
  /** Draw groups in vertex order: `map` null for the untextured, vertex-coloured triangles. */
  groups: { start: number; count: number; map: MapRef | null }[];
}

/** The base colour map of a material, when it has one the project's asset store can serve: a packaged image (18.4). */
export function mapOf(model: EditorModel, material: string | null): { ref: MapRef; size: [number, number]; offset?: [number, number]; rotation?: number } | null {
  if (material === null) return null;
  const m = (model.document.materials ?? {})[material] as Json | undefined;
  const tex = m?.['texture'] as Json | undefined;
  const asset = tex?.['asset'];
  const size = tex?.['size'] as [number, number] | undefined;
  if (typeof asset !== 'string' || size === undefined) return null;
  const a = (model.document.assets ?? {})[asset] as Json | undefined;
  const sha256 = a?.['sha256'];
  // A file by `uri` is somebody else's web server: the editor never fetches it (FS-LINT-007).
  if (typeof sha256 !== 'string' || typeof a?.['path'] !== 'string' || a['mediaType'] === 'image/ktx2') return null;
  return {
    ref: { key: `${material}:${sha256}`, material, sha256, color: materialColour(model, material) },
    size,
    ...(Array.isArray(tex?.['offset']) ? { offset: tex['offset'] as [number, number] } : {}),
    ...(typeof tex?.['rotation'] === 'number' ? { rotation: tex['rotation'] } : {}),
  };
}

/** The colour of a group with no map: its material's colour, or the view's default for that surface. */
function colourOf(model: EditorModel, part: MeshPart, g: SurfaceGroup): string {
  const own = materialColour(model, g.material);
  if (own !== null) return own;
  switch (part.kind) {
    case 'wall': {
      const layers = part.layers ?? [];
      if (g.surface?.kind === 'face' || g.surface?.kind === 'region') return g.surface.side === 'left' ? DEFAULTS.exterior : DEFAULTS.interior;
      const core = layers.length === 0 ? null : layers[Math.floor(layers.length / 2)];
      return materialColour(model, core) ?? DEFAULTS.wallEdge;
    }
    case 'junctionFill':
      // A face in one of its walls' planes is that face; the rest (its top) is the walls' core, as a wall's top is.
      if (g.surface?.kind === 'face' || g.surface?.kind === 'region') return g.surface.side === 'left' ? DEFAULTS.exterior : DEFAULTS.interior;
      return DEFAULTS.fill;
    case 'floor':
    case 'threshold':
      return DEFAULTS.floor;
    case 'ceiling':
      return DEFAULTS.ceiling;
    default:
      return DEFAULTS.fill;
  }
}

/** Whether a part's faces are finished surfaces this module lays out. */
export const isSurfacePart = (part: Pick<MeshPart, 'kind'>): boolean =>
  part.kind === 'wall' || part.kind === 'floor' || part.kind === 'ceiling' || part.kind === 'junctionFill' || part.kind === 'threshold';

/**
 * A surface part's buffers: its groups' triangles one after another, untextured groups first (one
 * draw group, vertex-coloured), then each map's triangles together (one draw group per map).
 */
export function surfaceBuffers(model: EditorModel, mesh: HouseMesh, part: MeshPart): SurfaceBuffers {
  const derived = model.derived;
  if (derived === null) throw new Error('surfaceBuffers needs a derived model');
  const groups = surfaceGroups(model.view, derived, part, mesh.origin, mesh.unitsPerMetre);
  const plain: SurfaceGroup[] = [];
  const mapped = new Map<string, { map: NonNullable<ReturnType<typeof mapOf>>; groups: SurfaceGroup[] }>();
  for (const g of groups) {
    const map = g.surface === null ? null : mapOf(model, g.material);
    if (map === null) plain.push(g);
    else {
      const entry = mapped.get(map.ref.key) ?? { map, groups: [] };
      entry.groups.push(g);
      mapped.set(map.ref.key, entry);
    }
  }
  const n = groups.reduce((k, g) => k + g.positions.length / 3, 0);
  const out: SurfaceBuffers = { positions: new Float32Array(3 * n), normals: new Float32Array(3 * n), colors: new Float32Array(3 * n), uvs: new Float32Array(2 * n), groups: [] };
  let at = 0;
  const put = (g: SurfaceGroup, uv: ((s: number, t: number) => [number, number]) | null) => {
    const count = g.positions.length / 3;
    out.positions.set(g.positions, 3 * at);
    out.normals.set(g.normals, 3 * at);
    const rgb = uv === null ? linear(colourOf(model, part, g)) : ([1, 1, 1] as const);
    for (let i = 0; i < count; i++) {
      out.colors.set(rgb, 3 * (at + i));
      if (uv !== null) out.uvs.set(uv(g.st[2 * i] ?? 0, g.st[2 * i + 1] ?? 0), 2 * (at + i));
    }
    at += count;
  };
  const start0 = at;
  for (const g of plain) put(g, null);
  if (at > start0) out.groups.push({ start: start0, count: at - start0, map: null });
  for (const { map, groups: gs } of mapped.values()) {
    const start = at;
    const placement = { size: map.size, ...(map.offset === undefined ? {} : { offset: map.offset }), ...(map.rotation === undefined ? {} : { rotation: map.rotation }) };
    for (const g of gs) put(g, (s, t) => tileCoordinates(s, t, placement));
    out.groups.push({ start, count: at - start, map: map.ref });
  }
  return out;
}
