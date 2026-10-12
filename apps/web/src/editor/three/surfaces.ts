import { flatShaded, surfaceGroups, tileCoordinates, worldCoordinates, type HouseMesh, type MeshPart, type ModelRole, type SurfaceGroup } from '@floorspec/mesh';
import { isLibraryGlass, LIBRARY_FILES, roleMaterial } from '@floorspec/mesh/materials';
import type { EditorModel } from '../model';
import { appearance, DEFAULTS, linear, materialColour } from './parts';

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

/**
 * A material's maps, as the view loads them (FLR-T-8.2, FLR-T-13.6): each file by its digest —
 * its base colour, its normals, its occlusion-roughness-metalness — with the factors Core 18.1 lays
 * over them. One per document material (or per role of a model's pieces the library dresses).
 */
export interface MapRef {
  /** One per material and maps: what a three.js material is cached by. */
  key: string;
  /** The document's material ID, or `role:<role>` for a model's piece (FLR-T-13.6). */
  material: string;
  /** The base colour map's digest; empty for a colour-agnostic material (a paint's sheen, siding's courses). */
  sha256: string;
  /** The normal map's digest. */
  normal?: string;
  /** The metallic-roughness map's digest, which with the library's ORM files is the occlusion map too. */
  orm?: string;
  /** The ambient occlusion map's digest, when it is a file of its own. */
  occlusion?: string;
  /** The material's colour: shown until the image arrives, and the base colour where there is no base colour map (Core 18.1). */
  color: string | null;
  /** 0–1: the factors, multiplying the map's channels where there is one (18.1); absent factors are 1 over a map, else Core's defaults. */
  roughness: number;
  metalness: number;
  /** Library glass (FLR-T-13.6): drawn see-through. */
  glass?: boolean;
}

export interface SurfaceBuffers {
  positions: Float32Array;
  normals: Float32Array;
  /** Linear RGB per vertex: the surface's colour, or white under a base colour map (the map is the colour). */
  colors: Float32Array;
  uvs: Float32Array;
  /** Draw groups in vertex order: `map` null for the untextured, vertex-coloured triangles. */
  groups: { start: number; count: number; map: MapRef | null }[];
}

/** How a material's texture is laid (Core 18.2), and its maps. */
export interface Mapped {
  ref: MapRef;
  size: [number, number];
  offset?: [number, number];
  rotation?: number;
}

/** An asset's digest when it is a packaged image the view can draw (18.4): never a file by `uri` (FS-LINT-007), never KTX2. */
function digestOf(model: EditorModel, asset: unknown): string | undefined {
  if (typeof asset !== 'string') return undefined;
  const a = (model.document.assets ?? {})[asset] as Json | undefined;
  const sha256 = a?.['sha256'];
  if (typeof sha256 !== 'string' || typeof a?.['path'] !== 'string' || a['mediaType'] === 'image/ktx2') return undefined;
  return sha256;
}

const thousandths = (v: unknown): number | undefined => (typeof v === 'number' ? v / 1000 : undefined);

/** A material's maps, when its texture has one the view can draw — a base colour map, a normal map or a metallic-roughness map. */
export function mapOf(model: EditorModel, material: string | null): Mapped | null {
  if (material === null) return null;
  const m = (model.document.materials ?? {})[material] as Json | undefined;
  const tex = m?.['texture'] as Json | undefined;
  const size = tex?.['size'] as [number, number] | undefined;
  if (tex === undefined || size === undefined) return null;
  const albedo = digestOf(model, tex['asset']);
  const normal = digestOf(model, tex['normal']);
  const orm = digestOf(model, tex['metallicRoughness']);
  const occlusion = digestOf(model, tex['occlusion']);
  if (albedo === undefined && normal === undefined && orm === undefined) return null;
  const r = thousandths(m?.['roughness']);
  const k = thousandths(m?.['metallic']);
  const ref: MapRef = {
    key: `${material}:${[albedo, normal, orm, occlusion].map((d) => d?.slice(0, 12) ?? '-').join(':')}:${String(r)}:${String(k)}`,
    material,
    sha256: albedo ?? '',
    ...(normal === undefined ? {} : { normal }),
    ...(orm === undefined ? {} : { orm }),
    ...(occlusion === undefined || occlusion === orm ? {} : { occlusion }),
    color: materialColour(model, material),
    roughness: r ?? 1,
    metalness: k ?? (orm === undefined ? 0 : 1),
    ...(isLibraryGlass(m) ? { glass: true } : {}),
  };
  return {
    ref,
    size,
    ...(Array.isArray(tex['offset']) ? { offset: tex['offset'] as [number, number] } : {}),
    ...(typeof tex['rotation'] === 'number' ? { rotation: tex['rotation'] } : {}),
  };
}

/** What a model's piece of a role is drawn in, when the material library dresses it (FLR-T-13.6). */
export function roleMapOf(role: ModelRole): Mapped | null {
  const item = roleMaterial(role);
  const t = item?.texture;
  if (item === undefined || t === undefined) return null;
  const digest = (file: string | undefined) => (file === undefined ? undefined : LIBRARY_FILES[file]?.sha256);
  const albedo = digest(t.maps.albedo);
  const normal = digest(t.maps.normal);
  const orm = digest(t.maps.orm);
  return {
    ref: {
      key: `role:${role}`,
      material: `role:${role}`,
      sha256: albedo ?? '',
      ...(normal === undefined ? {} : { normal }),
      ...(orm === undefined ? {} : { orm }),
      color: item.color,
      roughness: item.roughness === undefined ? 1 : item.roughness / 1000,
      metalness: item.metallic === undefined ? (orm === undefined ? 0 : 1) : item.metallic / 1000,
    },
    size: [t.size[0], t.size[1]],
  };
}

/** The tile placement of a mapped material (18.2). */
const placementOf = (map: Mapped) => ({ size: map.size, ...(map.offset === undefined ? {} : { offset: map.offset }), ...(map.rotation === undefined ? {} : { rotation: map.rotation }) });

/**
 * The colour of a group with no map: its material's colour, or the default for that surface — a
 * room's floor, ceiling and wall paint by what the room is for (FLR-T-12.23), as the worker draws it.
 */
function colourOf(model: EditorModel, part: MeshPart, g: SurfaceGroup): string {
  const own = materialColour(model, g.material);
  if (own !== null) return own;
  const look = appearance(model);
  const s = g.surface;
  if (s?.kind === 'face' || s?.kind === 'region') return look.face(s.wall, s.side).color;
  if (s?.kind === 'floor') return look.floor(s.room).color;
  if (s?.kind === 'ceiling') return look.ceiling(s.room).color;
  // A floor drawn down to the ceiling below (FLR-T-12.32): its underside over no room, its edges.
  if (g.plenum !== undefined) return look.plenum(g.plenum, part.plenum?.room).color;
  switch (part.kind) {
    case 'wall': {
      // Its top, ends and reveals: its core's.
      const layers = part.layers ?? [];
      const core = layers.length === 0 ? null : layers[Math.floor(layers.length / 2)];
      return materialColour(model, core) ?? DEFAULTS.wallEdge;
    }
    case 'threshold':
      return part.threshold === undefined ? DEFAULTS.floor : look.floor(part.threshold.room).color;
    case 'ceiling':
      return look.ceiling(part.id).color;
    case 'floor':
      return look.floor(part.id).color;
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
  const mapped = new Map<string, { map: Mapped; groups: SurfaceGroup[] }>();
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
  const put = (g: SurfaceGroup, uv: ((s: number, t: number) => [number, number]) | null, under?: readonly [number, number, number]) => {
    const count = g.positions.length / 3;
    out.positions.set(g.positions, 3 * at);
    out.normals.set(g.normals, 3 * at);
    // Under a base colour map the map is the colour; a colour-agnostic material's maps are only relief, over its colour.
    const rgb = uv === null ? linear(colourOf(model, part, g)) : (under ?? ([1, 1, 1] as const));
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
    const placement = placementOf(map);
    for (const g of gs) put(g, (s, t) => tileCoordinates(s, t, placement), map.ref.sha256 === '' ? linear(colourOf(model, part, g)) : undefined);
    out.groups.push({ start, count: at - start, map: map.ref });
  }
  return out;
}

/**
 * A part Core 18.3 lays no texture on, drawn with one (FLR-T-13.6): a roof, a slab or a gable end in
 * its document material, a model's piece in the library material its role is dressed in — its
 * triangles flat-shaded, with world-scale coordinates (@floorspec/mesh `worldCoordinates`: a roof
 * along its slopes, the rest by a box projection) so the map is its real size there. Null where
 * there is no map to draw: the part keeps its plain colours.
 */
export function mappedPartBuffers(model: EditorModel, mesh: HouseMesh, part: MeshPart, colours: (normals: Float32Array) => Float32Array): SurfaceBuffers | null {
  const map =
    part.model !== undefined
      ? roleMapOf(part.model.role)
      : part.kind === 'roof' || part.kind === 'slab'
        ? mapOf(model, part.material ?? null)
        : part.kind === 'roofGable'
          ? mapOf(model, part.cladding?.material ?? null)
          : null;
  if (map === null) return null;
  const { positions, normals } = flatShaded(part.mesh);
  const st = worldCoordinates(part.kind, positions, mesh.origin, mesh.unitsPerMetre);
  const n = positions.length / 3;
  const uvs = new Float32Array(2 * n);
  const placement = placementOf(map);
  for (let i = 0; i < n; i++) uvs.set(tileCoordinates(st[2 * i] ?? 0, st[2 * i + 1] ?? 0, placement), 2 * i);
  const colors = map.ref.sha256 === '' ? colours(normals) : new Float32Array(3 * n).fill(1);
  return { positions, normals, colors, uvs, groups: [{ start: 0, count: n, map: map.ref }] };
}
