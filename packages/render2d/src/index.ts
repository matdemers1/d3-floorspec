/**
 * @floorspec/render2d — the deterministic SVG plan renderer (FLR-T-2.8). Isomorphic: no Node APIs,
 * so the editor, the server and the worker draw the same plan from the same bytes.
 */
export const PACKAGE_NAME = '@floorspec/render2d';

export { renderPlan, renderEvaluation, labelPoint, DEFAULT_SCALE, ROOF_LINES, type RenderOptions, type EvaluationRenderOptions } from './render.js';
export { buildScene, sceneOf, defaultLevel, DEFAULT_READER, type ReaderOptions, type Scene, type SceneWall, type SceneOpening, type SceneRoom, type SceneSeparator, type SceneFace, type SceneFallback, type SceneClearance, type SceneStair, type Pt, type OpeningKind } from './scene.js';
export { roofSymbol, stairSymbol, upPlacement, columnRadius, newelOutline, CUT_HEIGHT, type RoofSymbol, type StairSymbol, type NewelSource } from './symbols.js';
export { diffScenes, type Change, type SceneDiff, type Diff } from './ghost.js';
export { PALETTES, ACCENT, type Palette, type ThemeName } from './theme.js';
export { feetInches, inches, squareFeet, num, BU_PER_FOOT, BU_PER_INCH, SQ_BU_PER_SQ_FT } from './format.js';
