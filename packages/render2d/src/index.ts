/**
 * @floorspec/render2d — the deterministic SVG plan renderer (FLR-T-2.8). Isomorphic: no Node APIs,
 * so the editor, the server and the worker draw the same plan from the same bytes.
 */
export const PACKAGE_NAME = '@floorspec/render2d';

export { renderPlan, labelPoint, DEFAULT_SCALE, type RenderOptions } from './render.js';
export { buildScene, defaultLevel, type Scene, type SceneWall, type SceneOpening, type SceneRoom, type SceneSeparator, type SceneFace, type SceneFallback, type SceneClearance, type Pt, type OpeningKind } from './scene.js';
export { roofSymbol, stairSymbol, columnRadius, CUT_HEIGHT, type RoofSymbol, type StairSymbol } from './symbols.js';
export { diffScenes, type Change, type SceneDiff, type Diff } from './ghost.js';
export { PALETTES, ACCENT, type Palette, type ThemeName } from './theme.js';
export { feetInches, inches, squareFeet, num, BU_PER_FOOT, BU_PER_INCH, SQ_BU_PER_SQ_FT } from './format.js';
