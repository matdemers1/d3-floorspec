/**
 * Fallback models merged into the glTF export (FLR-T-9.2, Core 12.6): an extension element whose
 * fallback names a glTF binary has that model's scene drawn at the element's placement, not only a
 * marker node there.
 *
 * Core 12.6's model is in glTF's own frame — metres, +Y up, its +X the element's front — which is
 * the export's frame too, so the model's root nodes become children of the element's marker node
 * (the placement's translation and its turn about +Y) unchanged. Everything a model's scene reaches
 * is copied once per model — its meshes, accessors, buffer views, materials, textures, samplers and
 * PNG or JPEG images, as they are — so several elements sharing one model share its meshes; only
 * the nodes are copied per element, since a glTF node has one parent. What its scene does not reach
 * (animations, skins, cameras, other scenes) is left behind.
 *
 * A model this export cannot carry faithfully is left out, its marker kept, and the summary says
 * why: bytes that are not a glTF 2.0 binary, data outside the binary (a URI), an extension the
 * model requires, or a reference to something the model does not have.
 */

type Json = Record<string, unknown>;

/** The glTF being written, as merge appends to it. */
export interface MergeTarget {
  /** Append bytes as a buffer view; answers its index. */
  view(bytes: Uint8Array, extra?: Json): number;
  readonly accessors: Json[];
  readonly meshes: Json[];
  readonly materials: Json[];
  readonly textures: Json[];
  readonly images: Json[];
  readonly samplers: Json[];
  readonly nodes: Json[];
  readonly extensionsUsed: Set<string>;
}

/** A model copied in: makes a fresh copy of its scene's nodes for each element, answering their indices. */
export type MergedModel = (prefix: string) => number[];

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isObject) : []);
const index = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);

/** A .glb's JSON and BIN chunk; null when the bytes are not a glTF 2.0 binary. */
function parseGlb(bytes: Uint8Array): { json: Json; bin: Uint8Array | null } | null {
  if (bytes.byteLength < 20) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint32(0, true) !== 0x46546c67 || v.getUint32(4, true) !== 2 || v.getUint32(16, true) !== 0x4e4f534a) return null;
  const jsonLength = v.getUint32(12, true);
  if (20 + jsonLength > bytes.byteLength) return null;
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
  } catch {
    return null;
  }
  if (!isObject(json)) return null;
  const at = 20 + jsonLength;
  let bin: Uint8Array | null = null;
  if (at + 8 <= bytes.byteLength && v.getUint32(at + 4, true) === 0x004e4942) {
    const length = v.getUint32(at, true);
    if (at + 8 + length > bytes.byteLength) return null;
    bin = bytes.subarray(at + 8, at + 8 + length);
  }
  return { json, bin };
}

/**
 * Copy a model's scene into `target`; a reason instead when it cannot be carried as it is. Nothing
 * is appended to `target` until the model has been read and found fit.
 */
export function mergeModel(target: MergeTarget, bytes: Uint8Array): MergedModel | { reason: string } {
  const glb = parseGlb(bytes);
  if (glb === null) return { reason: 'it is not a glTF 2.0 binary' };
  const { json, bin } = glb;
  const asset = isObject(json['asset']) ? json['asset'] : {};
  if (asset['version'] !== '2.0') return { reason: 'it is not a glTF 2.0 binary' };
  const required = Array.isArray(json['extensionsRequired']) ? json['extensionsRequired'] : [];
  if (required.length > 0) return { reason: `it requires ${required.map(String).join(', ')}, which this export does not carry` };
  const buffers = list(json['buffers']);
  if (buffers.length > 1 || buffers.some((b) => b['uri'] !== undefined)) return { reason: 'its data is outside the binary' };
  const images = list(json['images']);
  if (images.some((i) => i['uri'] !== undefined)) return { reason: 'its images are outside the binary' };
  const nodes = list(json['nodes']);
  const scenes = list(json['scenes']);
  const roots = (scenes[index(json['scene']) ?? 0]?.['nodes'] as unknown[] | undefined ?? []).map(index).filter((n): n is number => n !== undefined && n < nodes.length);
  if (roots.length === 0) return { reason: 'its scene has no nodes' };

  const views = list(json['bufferViews']);
  const accessors = list(json['accessors']);
  const meshes = list(json['meshes']);
  const materials = list(json['materials']);
  const textures = list(json['textures']);
  const samplers = list(json['samplers']);
  // Read everything before writing anything: a view outside the binary fails the model whole.
  for (const view of views) {
    const offset = index(view['byteOffset']) ?? 0;
    const length = index(view['byteLength']);
    if (index(view['buffer']) !== 0 || length === undefined || bin === null || offset + length > bin.byteLength) return { reason: 'a buffer view reaches outside its binary' };
  }

  /** The extensions a copied object uses, anywhere in it: declared in the export's extensionsUsed. */
  const used = <T>(value: T): T => {
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (isObject(v))
        for (const [k, x] of Object.entries(v)) {
          if (k === 'extensions' && isObject(x)) for (const name of Object.keys(x)) target.extensionsUsed.add(name);
          walk(x);
        }
    };
    walk(value);
    return value;
  };
  const memo = (fn: (i: number) => number): ((i: number) => number) => {
    const done = new Map<number, number>();
    return (i) => {
      let at = done.get(i);
      if (at === undefined) {
        at = fn(i);
        done.set(i, at);
      }
      return at;
    };
  };
  const must = <T>(items: readonly T[], i: number, what: string): T => {
    const item = items[i];
    if (item === undefined) throw new RangeError(`${what} ${String(i)} is not in the model`);
    return item;
  };

  const viewOf = memo((i) => {
    const v = must(views, i, 'buffer view');
    const offset = index(v['byteOffset']) ?? 0;
    const length = index(v['byteLength']) ?? 0;
    const extra: Json = {};
    if (v['byteStride'] !== undefined) extra['byteStride'] = v['byteStride'];
    if (v['target'] !== undefined) extra['target'] = v['target'];
    return target.view((bin as Uint8Array).slice(offset, offset + length), extra);
  });
  const accessorOf = memo((i) => {
    const a = { ...must(accessors, i, 'accessor') };
    const view = index(a['bufferView']);
    if (view !== undefined) a['bufferView'] = viewOf(view);
    if (isObject(a['sparse'])) {
      const sparse = a['sparse'];
      a['sparse'] = {
        ...sparse,
        ...(isObject(sparse['indices']) ? { indices: { ...sparse['indices'], bufferView: viewOf(index(sparse['indices']['bufferView']) ?? -1) } } : {}),
        ...(isObject(sparse['values']) ? { values: { ...sparse['values'], bufferView: viewOf(index(sparse['values']['bufferView']) ?? -1) } } : {}),
      };
    }
    used(a);
    return target.accessors.push(a) - 1;
  });
  const samplerOf = memo((i) => target.samplers.push(used({ ...must(samplers, i, 'sampler') })) - 1);
  const imageOf = memo((i) => {
    const image = { ...must(images, i, 'image') };
    const view = index(image['bufferView']);
    if (view !== undefined) image['bufferView'] = viewOf(view);
    return target.images.push(used(image)) - 1;
  });
  const textureOf = memo((i) => {
    const t = { ...must(textures, i, 'texture') };
    const source = index(t['source']);
    const sampler = index(t['sampler']);
    if (source !== undefined) t['source'] = imageOf(source);
    if (sampler !== undefined) t['sampler'] = samplerOf(sampler);
    return target.textures.push(used(t)) - 1;
  });
  /** A material with every texture it names — its own and its extensions' (`…Texture: { index }`) — remapped. */
  const remapTextures = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(remapTextures);
    if (!isObject(value)) return value;
    const out: Json = {};
    for (const [k, v] of Object.entries(value)) {
      const at = isObject(v) ? index(v['index']) : undefined;
      out[k] = k.endsWith('Texture') && isObject(v) && at !== undefined ? { ...v, index: textureOf(at) } : remapTextures(v);
    }
    return out;
  };
  const materialOf = memo((i) => target.materials.push(used(remapTextures(must(materials, i, 'material')) as Json)) - 1);
  const attributes = (map: unknown): Json => Object.fromEntries(Object.entries(isObject(map) ? map : {}).map(([k, v]) => [k, accessorOf(index(v) ?? -1)]));
  const meshOf = memo((i) => {
    const mesh = must(meshes, i, 'mesh');
    const primitives = list(mesh['primitives']).map((p) => {
      const indices = index(p['indices']);
      const material = index(p['material']);
      return {
        ...p,
        attributes: attributes(p['attributes']),
        ...(indices === undefined ? {} : { indices: accessorOf(indices) }),
        ...(material === undefined ? {} : { material: materialOf(material) }),
        ...(Array.isArray(p['targets']) ? { targets: (p['targets'] as unknown[]).map(attributes) } : {}),
      };
    });
    return target.meshes.push(used({ ...mesh, primitives })) - 1;
  });

  // Reach the scene and check every reference in it first, so a broken model is refused before
  // anything of it is written.
  const checkView = (i: unknown): void => { must(views, index(i) ?? -1, 'buffer view'); };
  const checkAccessor = (i: unknown): void => {
    const a = must(accessors, index(i) ?? -1, 'accessor');
    if (a['bufferView'] !== undefined) checkView(a['bufferView']);
    if (isObject(a['sparse'])) {
      checkView(isObject(a['sparse']['indices']) ? a['sparse']['indices']['bufferView'] : -1);
      checkView(isObject(a['sparse']['values']) ? a['sparse']['values']['bufferView'] : -1);
    }
  };
  const checkTextures = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(checkTextures);
    if (!isObject(value)) return;
    for (const [k, v] of Object.entries(value)) {
      if (k.endsWith('Texture') && isObject(v) && v['index'] !== undefined) {
        const t = must(textures, index(v['index']) ?? -1, 'texture');
        if (t['sampler'] !== undefined) must(samplers, index(t['sampler']) ?? -1, 'sampler');
        if (t['source'] !== undefined) {
          const image = must(images, index(t['source']) ?? -1, 'image');
          if (image['bufferView'] !== undefined) checkView(image['bufferView']);
        }
      }
      checkTextures(v);
    }
  };
  const reach = (i: number, seen: Set<number>): void => {
    if (seen.has(i)) throw new RangeError('its nodes form a cycle');
    seen.add(i);
    const n = must(nodes, i, 'node');
    if (n['mesh'] !== undefined)
      for (const p of list(must(meshes, index(n['mesh']) ?? -1, 'mesh')['primitives'])) {
        for (const a of Object.values(isObject(p['attributes']) ? p['attributes'] : {})) checkAccessor(a);
        for (const t of list(p['targets'])) for (const a of Object.values(t)) checkAccessor(a);
        if (p['indices'] !== undefined) checkAccessor(p['indices']);
        if (p['material'] !== undefined) checkTextures(must(materials, index(p['material']) ?? -1, 'material'));
      }
    for (const c of (Array.isArray(n['children']) ? n['children'] : []) as unknown[]) reach(index(c) ?? -1, seen);
  };
  const reached = new Set<number>();
  try {
    for (const r of roots) reach(r, reached);
  } catch (e) {
    return { reason: e instanceof Error ? e.message : 'its scene could not be read' };
  }
  for (const r of reached) {
    const mesh = index(nodes[r]?.['mesh']);
    if (mesh !== undefined) meshOf(mesh);
  }

  // A node's own extensions point at data at the model's root, which is not copied: they stay behind.
  const KEEP = ['matrix', 'translation', 'rotation', 'scale', 'weights', 'extras'] as const;
  const copy = (i: number, prefix: string): number => {
    const n = nodes[i] as Json;
    const out: Json = { name: typeof n['name'] === 'string' ? `${prefix} ${n['name']}` : prefix };
    for (const k of KEEP) if (n[k] !== undefined) out[k] = n[k];
    const mesh = index(n['mesh']);
    if (mesh !== undefined) out['mesh'] = meshOf(mesh);
    const at = target.nodes.push(out) - 1;
    const children = ((Array.isArray(n['children']) ? n['children'] : []) as unknown[]).map((c) => copy(index(c) as number, prefix));
    if (children.length > 0) out['children'] = children;
    return at;
  };
  return (prefix) => roots.map((r) => copy(r, prefix));
}
