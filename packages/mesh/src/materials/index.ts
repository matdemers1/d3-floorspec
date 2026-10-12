/**
 * @floorspec/mesh/materials — the material library (FLR-T-13.6): CC0 physically based materials at
 * their real-world size — woods, decking, tile, stone, brick, plaster, concrete, paint sheens, metals,
 * fabrics, glass, roofing, siding and pavers — each one a Core material (8.5, 18.1) ready to embed,
 * with its maps as assets (18.2, 18.4) and its `source` naming this library and the item (8.1).
 *
 * The maps are files beside this package (`materials/`, their sources, digests and licence in
 * `SOURCES.json` and `NOTICE.md`): an albedo (base colour) map, a +Y-up normal map and an ORM map —
 * occlusion in red, roughness in green, metalness in blue, glTF's metallic-roughness map with its
 * occlusion packed in, so one file is a material's `metallicRoughness` and its `occlusion`. An item
 * with no albedo map is colour-agnostic: its `color` is its base colour (18.1) and a person
 * chooses it — a paint's sheen, a plaster's trowel, siding's courses and a standing seam's ribs are
 * all its maps carry.
 *
 * Embedding is plain Floorspec ops (FLR-ADR-008): an asset per map file and the material, its
 * texture laid at the item's size. A document refers to nothing here by URL; once embedded, the
 * material is the document's own. A view that holds this package may draw a library digest from
 * the package's own file when the project's store lacks it — the file is the same bytes.
 *
 * Isomorphic: data and pure functions only.
 */
import { FILES, ITEMS } from './data.js';
import type { ModelRole } from '../roles.js';
import type { LibraryCategory, LibraryFile, LibraryItemData, LibraryMaps } from './types.js';

export type { LibraryCategory, LibraryFile, LibraryItemData, LibraryMaps, LibraryUse } from './types.js';

/** The library, as a material's `source` names it (Core 8.1.3). */
export const MATERIAL_LIBRARY = { library: 'https://d3cloud.io/floorspec/library/materials', version: '0.2.0', license: 'CC0-1.0' } as const;

/** Every item, in the library's order: by category, then as listed. */
export const LIBRARY_MATERIALS: readonly LibraryItemData[] = ITEMS;

/** The library's map files by file name. */
export const LIBRARY_FILES: Readonly<Record<string, LibraryFile>> = FILES;

/** The categories, in the order the picker shows them, with their names. */
export const LIBRARY_CATEGORIES: readonly { readonly id: LibraryCategory; readonly name: string }[] = [
  { id: 'wood', name: 'Wood' },
  { id: 'tile', name: 'Tile' },
  { id: 'stone', name: 'Stone' },
  { id: 'brick', name: 'Brick' },
  { id: 'plaster', name: 'Plaster' },
  { id: 'paint', name: 'Paint' },
  { id: 'concrete', name: 'Concrete' },
  { id: 'metal', name: 'Metal' },
  { id: 'fabric', name: 'Fabric' },
  { id: 'glass', name: 'Glass' },
  { id: 'roofing', name: 'Roofing' },
  { id: 'siding', name: 'Siding' },
  { id: 'decking', name: 'Decking' },
  { id: 'paver', name: 'Pavers' },
];

const BY_ID = new Map(ITEMS.map((i) => [i.id, i]));
const BY_DIGEST = new Map(Object.entries(FILES).map(([file, f]) => [f.sha256, file]));

/** An item by its ID. */
export const libraryMaterial = (id: string): LibraryItemData | undefined => BY_ID.get(id);

/** The library file whose bytes have this digest, or undefined: what lets a view draw a library map the project's store does not hold. */
export const libraryFileOf = (sha256: string): string | undefined => BY_DIGEST.get(sha256);

/** The asset ID an embedded map file is given: its file name without `.jpg` — `white-oak-plank.albedo`. */
export const assetIdOf = (file: string): string => file.replace(/\.jpg$/, '');

/** Where an embedded map's file is in a package (Core 18.4): by its digest, as the app's asset store names an upload. */
export const packagePathOf = (file: LibraryFile): string => `assets/${file.sha256}.jpg`;

type Json = Record<string, unknown>;
/** A Floorspec op, as a batch carries it. */
export type LibraryOp = Json & { readonly op: string };

/** Each of an item's maps by Core texture member (18.2): the ORM file is both `metallicRoughness` and `occlusion`. */
export function textureMembers(maps: LibraryMaps): { asset?: string; normal?: string; metallicRoughness?: string; occlusion?: string } {
  return {
    ...(maps.albedo === undefined ? {} : { asset: maps.albedo }),
    ...(maps.normal === undefined ? {} : { normal: maps.normal }),
    ...(maps.orm === undefined ? {} : { metallicRoughness: maps.orm, occlusion: maps.orm }),
  };
}

/** The asset element of one of the library's map files (Core 8.6, 18.4). */
export function assetElement(file: string, item?: LibraryItemData): Json {
  const f = FILES[file];
  if (f === undefined) throw new RangeError(`the library has no file ${file}`);
  const role = file.endsWith('.albedo.jpg') ? 'colour map' : file.endsWith('.normal.jpg') ? 'normal map' : 'occlusion-roughness-metalness map';
  return { path: packagePathOf(f), sha256: f.sha256, mediaType: f.mediaType, byteLength: f.byteLength, name: `${item?.name ?? assetIdOf(file)} — ${role}` };
}

export interface EmbedOptions {
  /** The material's ID. Default the item's, or the item's with a number after it where that is taken. */
  readonly id?: string;
  /** Its colour, for a colour-agnostic item (a paint, a plaster, siding): the base colour a person chose. */
  readonly color?: string;
  /** Its texture turned (Core 18.2, microdegrees counter-clockwise): 90 000 000 runs planks along t, north–south on a floor. */
  readonly rotation?: number;
  /** Its name. Default the item's. */
  readonly name?: string;
}

/** The asset IDs a document holds for each library file it holds, by digest: an embed reuses them. */
function heldAssets(document: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const assets = (document as { assets?: Record<string, Json | undefined> } | null)?.assets ?? {};
  for (const id of Object.keys(assets).sort()) {
    const sha = assets[id]?.['sha256'];
    if (typeof sha === 'string' && BY_DIGEST.has(sha) && !out.has(sha)) out.set(sha, id);
  }
  return out;
}

function holds(document: unknown, id: string): boolean {
  if (document === null || typeof document !== 'object') return false;
  return Object.values(document as Record<string, unknown>).some((c) => c !== null && typeof c === 'object' && !Array.isArray(c) && Object.hasOwn(c, id));
}

/**
 * The material element of an item: its colour and factors, its texture with each map named by the
 * asset ID `assets` gives its file, and its `source`.
 */
export function materialElement(item: LibraryItemData, assets: (file: string) => string, options: Pick<EmbedOptions, 'color' | 'rotation' | 'name'> = {}): Json {
  const t = item.texture;
  const members = t === undefined ? {} : textureMembers(t.maps);
  const texture =
    t === undefined
      ? undefined
      : {
          ...Object.fromEntries(Object.entries(members).map(([k, file]) => [k, assets(file)])),
          size: [t.size[0], t.size[1]],
          ...(options.rotation === undefined || options.rotation === 0 ? {} : { rotation: options.rotation }),
        };
  return {
    name: options.name ?? item.name,
    color: (options.color ?? item.color).toLowerCase(),
    ...(item.metallic === undefined ? {} : { metallic: item.metallic }),
    ...(item.roughness === undefined ? {} : { roughness: item.roughness }),
    ...(texture === undefined ? {} : { texture }),
    source: { library: MATERIAL_LIBRARY.library, version: MATERIAL_LIBRARY.version, item: item.id },
  };
}

/**
 * A document of Core 0.1 or 0.2 cannot hold a texture's normal or metallic-roughness map, a
 * material's factors, an asset's length or a `source` (0.3, 8.1, 18.1–18.4): the op that makes it
 * 0.3 first — which every 0.1 and 0.2 document already is a valid 0.3 document of — or none.
 */
export function coreUpgradeOps(document: unknown): LibraryOp[] {
  const v = (document as { floorspec?: unknown } | null)?.floorspec;
  return v === '0.1' || v === '0.2' ? [{ op: 'setProperty', id: '$document', path: '/floorspec', value: '0.3' }] : [];
}

/** The upgrade, once in a batch of embeds sharing `pending`. */
function upgradeOnce(document: unknown, pending: Map<string, string>): LibraryOp[] {
  if (pending.has('$document')) return [];
  pending.set('$document', '0.3');
  return coreUpgradeOps(document);
}

/** The asset ops an item needs that a document does not hold yet, and the asset ID of each of its files. */
function assetOps(document: unknown, item: LibraryItemData, pending: Map<string, string>): { ops: LibraryOp[]; idOf: (file: string) => string } {
  const held = heldAssets(document);
  const ops: LibraryOp[] = [];
  const ids = new Map<string, string>();
  const maps: LibraryMaps = item.texture?.maps ?? {};
  for (const file of new Set([maps.albedo, maps.normal, maps.orm].filter((f): f is string => f !== undefined))) {
    const f = FILES[file]!;
    const have = held.get(f.sha256) ?? pending.get(f.sha256);
    if (have !== undefined) {
      ids.set(file, have);
      continue;
    }
    let id = assetIdOf(file);
    for (let n = 2; holds(document, id); n++) id = `${assetIdOf(file)}-${String(n)}`;
    ops.push({ op: 'addElement', collection: 'assets', id, element: assetElement(file, item) });
    ids.set(file, id);
    pending.set(f.sha256, id);
  }
  return { ops, idOf: (file) => ids.get(file)! };
}

/**
 * The batch that embeds an item as a new material: an asset for each of its map files the document
 * does not hold already (by digest, so a map two materials share — a paint's stipple — is one
 * asset), then the material. Returns the material's ID with it.
 */
export function embedLibraryMaterial(document: unknown, itemId: string, options: EmbedOptions = {}, pending: Map<string, string> = new Map()): { id: string; ops: LibraryOp[] } {
  const item = BY_ID.get(itemId);
  if (item === undefined) throw new RangeError(`the material library has no item ${itemId}`);
  let id = options.id ?? item.id;
  if (options.id === undefined) for (let n = 2; holds(document, id); n++) id = `${item.id}-${String(n)}`;
  const assets = assetOps(document, item, pending);
  return { id, ops: [...upgradeOnce(document, pending), ...assets.ops, { op: 'addElement', collection: 'materials', id, element: materialElement(item, assets.idOf, options) }] };
}

/** JSON with every object's keys in order: two values the same whichever order their members were written in. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_, x: unknown) => (x !== null && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Json).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

/**
 * The batch that turns a document's existing material into a library item, in place — so every
 * finish, layer, slab and roof that names it is the library's now, and no reference moves. Its
 * name stays unless one is given; its colour stays for a colour-agnostic item unless one is given
 * (a person's paint colour is theirs), and is the item's otherwise.
 */
export function swapToLibraryMaterial(document: unknown, materialId: string, itemId: string, options: Omit<EmbedOptions, 'id'> = {}, pending: Map<string, string> = new Map()): LibraryOp[] {
  const item = BY_ID.get(itemId);
  if (item === undefined) throw new RangeError(`the material library has no item ${itemId}`);
  const current = (document as { materials?: Record<string, Json | undefined> } | null)?.materials?.[materialId];
  if (current === undefined) throw new RangeError(`the document has no material ${materialId}`);
  const agnostic = item.texture?.maps.albedo === undefined;
  const keep = typeof current['color'] === 'string' ? current['color'] : undefined;
  const assets = assetOps(document, item, pending);
  const next = materialElement(item, assets.idOf, {
    name: options.name ?? (typeof current['name'] === 'string' ? current['name'] : item.name),
    ...(options.color !== undefined ? { color: options.color } : agnostic && keep !== undefined ? { color: keep } : {}),
    ...(options.rotation === undefined ? {} : { rotation: options.rotation }),
  });
  const ops: LibraryOp[] = [...upgradeOnce(document, pending), ...assets.ops];
  for (const key of ['metallic', 'roughness', 'texture'])
    if (current[key] !== undefined && next[key] === undefined) ops.push({ op: 'unsetProperty', id: materialId, path: `/${key}` });
  for (const [key, value] of Object.entries(next)) if (canonical(current[key]) !== canonical(value)) ops.push({ op: 'setProperty', id: materialId, path: `/${key}`, value });
  return ops;
}

/**
 * The batch that brings every material a document embedded from an earlier build of the library up
 * to this one (FLR-T-13.17: 0.2.0's colour maps average to their item's colour; 0.1.0's were the
 * publishers' exposure, white oak a mid brown): each such material swapped in place to its item as
 * it is now — its maps' new files as assets, its colour the item's (a colour-agnostic item's stays
 * the person's), its name, turn and offset kept — and every asset only its old maps used removed.
 * Empty when every library material is current.
 */
export function refreshLibraryMaterials(document: unknown): LibraryOp[] {
  const doc = (document ?? {}) as { materials?: Record<string, Json | undefined>; assets?: Record<string, Json | undefined> };
  const pending = new Map<string, string>();
  const ops: LibraryOp[] = [];
  const dropped = new Set<string>();
  for (const id of Object.keys(doc.materials ?? {}).sort()) {
    const m = doc.materials![id]!;
    const item = libraryItemOfMaterial(m);
    if (item === undefined) continue;
    const tex = (m['texture'] ?? {}) as Json;
    const maps = item.texture === undefined ? {} : textureMembers(item.texture.maps);
    const current = Object.entries(maps).every(([k, file]) => {
      const a = typeof tex[k] === 'string' ? doc.assets?.[tex[k]] : undefined;
      return a?.['sha256'] === FILES[file]?.sha256;
    });
    if (current && (m['source'] as Json)['version'] === MATERIAL_LIBRARY.version) continue;
    const rotation = typeof tex['rotation'] === 'number' ? tex['rotation'] : undefined;
    const swap = swapToLibraryMaterial(document, id, item.id, rotation === undefined ? {} : { rotation }, pending);
    // The tile's offset is the person's placement: kept.
    if (Array.isArray(tex['offset']))
      for (const op of swap) if (op.op === 'setProperty' && op['path'] === '/texture') op['value'] = { ...(op['value'] as Json), offset: tex['offset'] };
    ops.push(...swap);
    for (const k of ['asset', 'normal', 'metallicRoughness', 'occlusion']) if (typeof tex[k] === 'string') dropped.add(tex[k]);
  }
  if (ops.length === 0) return ops;
  // An old map's asset goes when no material — nor anything else in the document — names it once the swaps are made.
  const named = new Set<string>();
  const swapped = new Set(ops.filter((o) => o.op === 'setProperty' && o['path'] === '/texture').map((o) => o['id'] as string));
  for (const op of ops) if (op.op === 'setProperty' && op['path'] === '/texture') for (const v of Object.values(op['value'] as Json)) if (typeof v === 'string') named.add(v);
  const rest = JSON.stringify({ ...doc, assets: undefined, materials: Object.fromEntries(Object.entries(doc.materials ?? {}).filter(([id]) => !swapped.has(id))) });
  for (const asset of [...dropped].sort()) if (!named.has(asset) && !rest.includes(JSON.stringify(asset))) ops.push({ op: 'removeElement', id: asset });
  return ops;
}

/** The library item a document's material was embedded from — its `source` names this library — or undefined. */
export function libraryItemOfMaterial(material: unknown): LibraryItemData | undefined {
  const source = (material as { source?: { library?: unknown; item?: unknown } } | null | undefined)?.source;
  if (source?.library !== MATERIAL_LIBRARY.library || typeof source.item !== 'string') return undefined;
  return BY_ID.get(source.item);
}

/**
 * Whether a view draws a document's material see-through: one embedded from the library's glass,
 * whose look Core does not carry (18.1 has no transmission). A view's choice, not the standard's.
 */
export const isLibraryGlass = (material: unknown): boolean => libraryItemOfMaterial(material)?.look === 'glass';

/**
 * What a model's pieces are drawn in (FLR-T-12.21, 13.8): the library item each role's look is laid
 * with in every view — a counter's stone as white quartz, a cabinet's wood as rift oak, a sofa's
 * body as wool, a sink as brushed stainless — at its real size by the box projection
 * (texcoords.ts). A view's choice (Core 0.5): no document names these, and a role with none here
 * keeps its plain look (roles.ts `ROLE_LOOKS`).
 */
export const ROLE_LIBRARY: Readonly<Partial<Record<ModelRole, string>>> = {
  stone: 'quartz-white',
  stainless: 'stainless-brushed',
  wood: 'white-oak-veneer',
  door: 'white-oak-veneer',
  fabric: 'wool-herringbone',
  cushion: 'linen-natural',
  linen: 'linen-natural',
  rug: 'carpet-wool-beige',
  brass: 'brass-satin',
  darkMetal: 'steel-blackened',
  paver: 'bluestone-pavers',
  brick: 'brick-red-running',
  concrete: 'concrete-smooth',
};

/** The library item a model's piece of this role is drawn in, or undefined. */
export const roleMaterial = (role: ModelRole): LibraryItemData | undefined => {
  const id = ROLE_LIBRARY[role];
  return id === undefined ? undefined : BY_ID.get(id);
};
