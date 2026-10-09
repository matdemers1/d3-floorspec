/**
 * 3D exports (FLR-T-9.2): glTF 2.0 binary and USDZ, both written from one scene of one version in
 * one design (default the primary), which each file records.
 */
import { buildScene, type Scene, type SceneOptions } from './scene.js';
import { writeGlb, type ImageSource } from './glb.js';
import { writeUsdz } from './usdz.js';

export { buildScene, buildSceneFrom, sceneOf, getMesher, linear, tileUV, DEFAULTS, MAP_ROLES, type Scene, type SceneMaterial, type SceneNode, type ScenePrimitive, type SceneLevel, type SceneRoom, type SceneDoor, type SceneObstacle, type SceneOptions, type ElementKind, type Vec3 } from './scene.js';
export { writeGlb, readGlb, type GlbOptions, type GlbResult, type ImageSource, type ModelsReport } from './glb.js';
export { writeUsdz, usdaOf, type UsdzResult } from './usdz.js';
export { storeZip, readStoreZip } from './zip.js';
export { assetDirImages, assetDirModels, looksLike } from './assets.js';
export { mergeModel, type MergeTarget, type MergedModel } from './merge.js';

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
  const glb = writeGlb(scene, { generator: GENERATOR, about: about(scene, options), ...(options.images === undefined ? {} : { images: options.images }), ...(options.models === undefined ? {} : { models: options.models }) });
  return {
    name: fileName(scene, options.version, 'glb'),
    contentType: 'model/gltf-binary',
    bytes: glb.bytes,
    summary: summaryOf(scene, { triangles: glb.triangles, materials: glb.materials, textures: { embedded: glb.embedded, omitted: glb.omitted }, models: glb.models }),
  };
}

/** USDZ for AR Quick Look: a USDA root layer, UsdPreviewSurface materials, metres, +Y up. */
export async function exportUsdz(document: object, options: ModelExportOptions): Promise<ModelFile> {
  const scene = await buildScene(document, options);
  const usdz = writeUsdz(scene, { about: about(scene, options), ...(options.images === undefined ? {} : { images: options.images }) });
  return {
    name: fileName(scene, options.version, 'usdz'),
    contentType: 'model/vnd.usdz+zip',
    bytes: usdz.bytes,
    summary: summaryOf(scene, { triangles: usdz.triangles, materials: usdz.materials, textures: { embedded: usdz.embedded, omitted: usdz.omitted }, models: usdz.models }),
  };
}
