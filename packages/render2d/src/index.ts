/**
 * @floorspec/render2d — the deterministic SVG plan renderer (FLR-T-2.8). Isomorphic: no Node APIs,
 * so the editor, the server and the worker draw the same plan from the same bytes.
 */
export const PACKAGE_NAME = '@floorspec/render2d';

export { renderPlan, renderEvaluation, labelPoint, DEFAULT_SCALE, ROOF_LINES, GHOST_OPACITY, BEAM_STYLE, type RenderOptions, type EvaluationRenderOptions, type SymbolBytes } from './render.js';
export { buildScene, sceneOf, defaultLevel, boxFrame, categoryOf, DEFAULT_READER, type ReaderOptions, type Scene, type SceneWall, type SceneOpening, type SceneRoom, type SceneSeparator, type SceneFace, type SceneFallback, type SceneClearance, type SceneStair, type SceneWallType, type Pt, type OpeningKind } from './scene.js';
export { roofSymbol, stairSymbol, upPlacement, columnRadius, newelOutline, CUT_HEIGHT, type RoofSymbol, type StairSymbol, type NewelSource } from './symbols.js';
export { doorSymbol, fixtureSymbol, standsInRoom, symbolCorners, type DoorSymbol, type DoorSource, type WallFaces, type BoxFrame, type FixtureSource, type SymbolPart, type SymbolPath, type SymbolArc, type SymbolStroke } from './plansymbols.js';
export { diffScenes, type Change, type SceneDiff, type Diff } from './ghost.js';
export { PALETTES, ACCENT, type Palette, type ThemeName } from './theme.js';
export {
  beamOf,
  beamWords,
  BULB_SPACING,
  bulbCount,
  EXTERIOR_DEFS,
  EXTERIOR_KINDS,
  EXTERIOR_PATH,
  exteriorExtras,
  exteriorMembers,
  exteriorOf,
  isExteriorKind,
  stringBox,
  type Beam,
  type BeamShape,
  type ExteriorData,
  type ExteriorDef,
  type ExteriorKind,
  type ExteriorMount,
} from './exterior.js';
export { landscapeOf, landscapeLayers, type SceneLandscape } from './landscape.js';
export { outdoorOf, outdoorLayers, type SceneOutdoor, type SceneGate } from './outdoor.js';
export { contextLayers, contextExtent, contextTag, CONTEXT_TAGS, type ContextLayers, type ContextDrawOptions } from './context.js';
export { siteLayers, siteExtent, surveyHeight, type SiteLayers, type SiteDrawOptions } from './site.js';
export {
  PLAN_STYLES,
  STYLES,
  ALL_DETAILS,
  DARK_PULL,
  CONSTRUCTION_DOOR,
  isPlanStyle,
  defaultStyle,
  planTheme,
  materialTone,
  legibleUnder,
  TEXT_CONTRAST,
  inkOn,
  mix,
  shade,
  contrast,
  luminance,
  floorFinishOf,
  finishSource,
  floorPatternSvg,
  gridPatternSvg,
  hatchPatternSvg,
  shadowFilterSvg,
  patternId,
  wallClassOf,
  wallTypeColour,
  furnitureTone,
  isRug,
  type PlanStyle,
  type StyleDef,
  type StyleDetails,
  type PlanTheme,
  type FloorPattern,
  type FloorFinish,
  type FinishSource,
  type PatternFrame,
  type WallClass,
} from './styles.js';
export { MODE_IDS, MODES, PLAN_LAYERS, LAYER_STATES, LAYER_LABELS, ALL_ON, isModeId, isLayerState, layerStates, layerOfElement, type ModeId, type ModeDef, type PlanLayer, type LayerState, type LayerStates } from './modes.js';
export {
  RENOVATION_FILTERS,
  RENOVATION_FILTER_LABELS,
  RENOVATION_STATUS_LABELS,
  RENOVATION_INK,
  EXISTING_OPACITY,
  DEMOLISH_DASH,
  isRenovationFilter,
  renovationStyles,
  filteredDocument,
  type RenovationFilter,
  type RenovationStyle,
  type RenovationStatus,
} from './renovation.js';
export { feetInches, inches, squareFeet, num, BU_PER_FOOT, BU_PER_INCH, SQ_BU_PER_SQ_FT } from './format.js';
export { unionOutline, mergeCollinear, outlineLoops, outerLoops, insideRings, ccw, type OutlineEdge, type XY } from './outline.js';
export {
  exteriorStrings,
  roomStrings,
  customString,
  outerBoundary,
  openingMarks,
  tagsOf,
  layoutAnnotations,
  noteBox,
  annoSourceOf,
  approxMeasure,
  scaleBarOf,
  PDF_METRICS,
  SCREEN_METRICS,
  MIN_SPAN,
  SIDES,
  type AnnoSource,
  type AnnoWall,
  type AnnoOpening,
  type AnnoRoom,
  type DimString,
  type DimStop,
  type DimGroup,
  type Side,
  type LabelClear,
  type CustomDimension,
  type Tag,
  type MarkSource,
  type Note,
  type AnnoFont,
  type Measure,
  type AnnoMetrics,
  type AnnoPrim,
  type AnnoFrame,
  type AnnoInput,
  type AnnoLayout,
  type SideDepths,
  type ScaleBar,
} from './annotate.js';
