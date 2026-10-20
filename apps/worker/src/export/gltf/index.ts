/**
 * 3D exports (FLR-T-9.2): glTF 2.0 binary and USDZ, both written from one scene of one version in
 * one design (default the primary), which each file records.
 */
import { buildScene, type Scene, type SceneOptions } from './scene.js';
import { writeGlb, type ImageSource } from './glb.js';
import { writeUsdz } from './usdz.js';
import { arScene, SCALE_LABEL, type ArOptions } from './ar.js';
import { withLibrary } from './library.js';

export { buildScene, buildSceneFrom, sceneOf, getMesher, linear, tileUV, DEFAULTS, MAP_ROLES, type Scene, type SceneMaterial, type SceneNode, type ScenePrimitive, type SceneLevel, type SceneRoom, type SceneDoor, type SceneObstacle, type SceneOptions, type ElementKind, type Vec3 } from './scene.js';
export { writeGlb, readGlb, type GlbOptions, type GlbResult, type ImageSource, type ModelsReport } from './glb.js';
export { writeUsdz, usdaOf, groundShift, type UsdzResult } from './usdz.js';
export { arScene, capTexture, decimate, groupOf, AR_SCALES, SCALE_FACTOR, SCALE_LABEL, MAX_AR_TEXTURE, DECIMATE_CELL, type ArOptions, type ArScale, type ArInclude } from './ar.js';
export { storeZip, readStoreZip } from './zip.js';
export { assetDirImages, assetDirModels, looksLike } from './assets.js';
export { mergeModel, type MergeTarget, type MergedModel } from './merge.js';
export { libraryBytes, withLibrary } from './library.js';

export interface VersionFacts {
  readonly hash: string;
  readonly seq?: number | null;
}

export interface ModelExportOptions extends SceneOptions {
  readonly version: VersionFacts;
  /** The bytes of the assets a material's maps name, where the exporter can have them. */
  readonly images?: ImageSource;
  /** The bytes of the glTF binaries extension elements' fallbacks name (Core 12.6): merged into a glTF export. */
  readonly models?: ImageSource;
  /** USDZ (FLR-T-14.3): true scale or a table's 1:50, and what it includes. Default true scale, all but the site. */
  readonly ar?: ArOptions;
}

export interface ModelFile {
  readonly name: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly summary: Record<string, unknown>;
}

const GENERATOR = 'D3 Floorspec (Floorspec Core 0.3)';

const slug = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '-')
    .slice(0, 60) || 'floorspec';

function fileName(scene: Scene, version: VersionFacts, ext: string): string {
  const v = version.seq === undefined || version.seq === null ? version.hash.slice(0, 8) : `v${String(version.seq)}`;
  return `${slug(scene.project)}-${v}.${ext}`;
}

function about(scene: Scene, options: ModelExportOptions): Record<string, unknown> {
  return { version: options.version.hash, ...(options.version.seq === undefined || options.version.seq === null ? {} : { seq: options.version.seq }), project: scene.project, ...(options.levels === undefined ? {} : { levels: options.levels }) };
}

function summaryOf(scene: Scene, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    design: scene.design,
    levels: scene.levels.map((l) => l.id),
    elements: scene.levels.reduce((n, l) => n + l.nodes.length, 0),
    ...extra,
  };
}

/** glTF 2.0 binary: +Y up, metres, PBR materials, a node per element. */
export async function exportGltf(document: object, options: ModelExportOptions): Promise<ModelFile> {
  const scene = await buildScene(document, options);
  const glb = writeGlb(scene, { generator: GENERATOR, about: about(scene, options), images: withLibrary(options.images), ...(options.models === undefined ? {} : { models: options.models }) });
  return {
    name: fileName(scene, options.version, 'glb'),
    contentType: 'model/gltf-binary',
    bytes: glb.bytes,
    summary: summaryOf(scene, { triangles: glb.triangles, materials: glb.materials, textures: { embedded: glb.embedded, omitted: glb.omitted }, models: glb.models }),
  };
}

/**
 * USDZ for AR Quick Look: a USDA root layer, UsdPreviewSurface materials, metres, +Y up — tuned for
 * a phone (FLR-T-14.3): anchored on a horizontal plane, the lowest floor on the ground, at true scale
 * or 1:50, furniture and fixtures simplified, the site left out unless asked for.
 */
export async function exportUsdz(document: object, options: ModelExportOptions): Promise<ModelFile> {
  const ar: ArOptions = options.ar ?? { scale: 'true' };
  const scene = arScene(await buildScene(document, options), ar);
  const usdz = writeUsdz(scene, { about: about(scene, options), images: withLibrary(options.images), scale: ar.scale });
  return {
    name: ar.scale === 'table' ? fileName(scene, options.version, 'usdz').replace(/\.usdz$/, '-table.usdz') : fileName(scene, options.version, 'usdz'),
    contentType: 'model/vnd.usdz+zip',
    bytes: usdz.bytes,
    summary: summaryOf(scene, {
      triangles: usdz.triangles,
      materials: usdz.materials,
      textures: { embedded: usdz.embedded, omitted: usdz.omitted },
      models: usdz.models,
      ar: { scale: ar.scale, ratio: SCALE_LABEL[ar.scale], roofs: ar.roofs ?? true, furniture: ar.furniture ?? true, fixtures: ar.fixtures ?? true, site: ar.site ?? false, bytes: usdz.bytes.byteLength },
    }),
  };
}
