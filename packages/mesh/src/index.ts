/**
 * @floorspec/mesh — watertight 3D meshes derived from a Floorspec document (FLR-T-7.4,
 * FLR-REQ-112): walls with their openings cut, junction fills and the corners separators leave
 * closed, doorways' thresholds, openings' joinery (doors and windows, FLR-T-13.8), floors, ceilings,
 * slabs, roofs, stairs and extension elements
 * (procedural models of what they are, or their fallback boxes), built from what
 * @floorspec/engine derives exactly, with
 * manifold-3d (WASM, loaded lazily) for booleans and polygon triangulation.
 *
 * Isomorphic, like the engine (FLR-ADR-010): the same package in the browser and in Node. Exact
 * integers in base units (1/1280 mm) until the very end, then one conversion to Float32 metres.
 */
export const PACKAGE_NAME = '@floorspec/mesh';

export { loadMesher, meshDocument, type Mesher } from './mesher.js';
export { loadKernel, type KernelOptions } from './kernel.js';
export { flatShaded } from './shading.js';
export { appearanceOf, DEFAULT_COLOURS, paletteFunction, ROOM_PALETTE, swatch, type Appearance, type DefaultColour, type FaceSide, type Hex, type PaletteFunction, type RoomPalette, type Swatch } from './appearance.js';
export { openToSky } from './rooms.js';
export { autumnHue, bareCrown, blossoms, changesParts, foliageOf, fullLook, landscapeCollection, lawnRole, leafLitter, lookMesh, seasonRole, snowHold, snowSplit, wetPart, type AutumnHue, type Foliage } from './looks.js';
export { pairedElements } from './paired.js';
export { surfaceGroups, tileCoordinates, type Surface, type SurfaceGroup, type TilePlacement } from './surfaces.js';
export { DECOR_ROLES, LANDSCAPE_ROLES, LOOK_ROLES, MODEL_ROLES, ROLE_LOOKS, type ModelRole, type RoleLook } from './roles.js';
export { discriminant, elementKind } from './models/kinds.js';
export { decorFamily, libraryItemOf, LAMP_SHADES } from './models/decor.js';
export { islandBays } from './models/furniture.js';
export { gableCladding } from './cladding.js';
export { PART_KINDS, UNITS_PER_METRE, type Box3, type Cladding, type HouseMesh, type MeshOptions, type MeshPart, type PartKind, type PartMesh, type PartStats, type Vec3, type DoorState } from './types.js';
export { ENVELOPE, envelope, openEnvelope, openingFrame, type LocalBox, type OpeningFrame } from './joinery.js';
export { exteriorLamps, type ExteriorLamp } from './exterior.js';
export { DEFAULT_LUMENS, EXPOSURE_PER_NIT, kelvinColor, LAMP_LUMENS, lensGlows, lightsOf, LUMENS_PER_WATT, WHITE_BALANCE, type FixtureLight, type LensGlow } from './lights.js';
export {
  ALL_OFF,
  ALL_ON,
  ALL_ON_NAME,
  CCT_MAX,
  CCT_MIN,
  CCT_SLIDER,
  documentScenes,
  explicit,
  lightingData,
  luminairesOf,
  normalizeOn,
  OFF_NAME,
  sameLighting,
  sceneNamed,
  scenesOf,
  settingOf,
  toggled,
  withLights,
  withSetting,
  type Lighting,
  type LuminaireData,
  type NamedScene,
  type SceneSetting,
} from './scenes.js';
export { boxST, isSlope, slopeST, worldCoordinates } from './texcoords.js';
export { GLASS_F0, GLASS_GLSL, GLASS_IOR, glassAt, glassFresnel, paneTransmission } from './sky/glass.js';
export {
  APERTURES,
  ASPECT_RATIOS,
  ASPECTS,
  DEFAULT_FOCAL,
  describeLens,
  EXPOSURE_MAX,
  EXPOSURE_MIN,
  exposureFactor,
  FOCAL_MAX,
  FOCAL_MIN,
  fieldAcross,
  fNumber,
  focalForField,
  FRAME_LONG_MM,
  LEVELS_SHOWN,
  lensTangents,
  nextViewId,
  pictureSize,
  readView,
  savedViewNamed,
  savedViewsOf,
  toUnits,
  viewCamera,
  viewRecord,
  viewsData,
  type Aperture,
  type Aspect,
  type SavedView,
  type ViewCamera,
  type ViewLevels,
} from './views.js';
export {
  catmullRom,
  ease,
  EASE_LABELS,
  EASES,
  FILM_MAX_MS,
  FILM_MIN_MS,
  FILMS_PATH,
  filmCameraAt,
  filmClock,
  filmDuration,
  filmFrameCount,
  filmNamed,
  filmProblem,
  filmRecord,
  filmShots,
  filmsData,
  filmsOf,
  filmViewOf,
  MAX_FILM_KEYS,
  nextFilmId,
  readFilm,
  readFilmKey,
  RECORDED_FOCAL,
  type Ease,
  type Film,
  type FilmCamera,
  type FilmKey,
  type FilmShot,
} from './films.js';
export {
  DASH,
  DEFAULT_HEADER_DEPTH,
  DEFAULT_STUD_SPACING,
  DEFAULT_STUD_WIDTH,
  RUN_HEIGHT,
  studLayout,
  XRAY_SYSTEMS,
  xrayMeshes,
  xrayPlan,
  type FrameBox,
  type XrayFraming,
  type XrayMesh,
  type XrayPiece,
  type XrayPlan,
  type XrayRun,
  type XrayStyle,
  type XraySystem,
  type XrayWall,
} from './xray/index.js';
export {
  DEFAULT_EYE_HEIGHT,
  directionOf,
  equirectUv,
  equirectYawPitch,
  linkedDoorways,
  MAX_EYE_HEIGHT,
  MAX_TOUR_ROOMS,
  MIN_EYE_HEIGHT,
  TOUR_MAX_WORK,
  TOUR_QUALITIES,
  TOUR_SIZES,
  TOUR_SKY,
  tourAt,
  touredByDefault,
  tourFace,
  tourRoomsByDefault,
  tourWithinBudget,
  wrapYaw,
  yawPitch,
  type Point3,
  type TourHotspot,
  type TourLevel,
  type TourManifest,
  type TourPlanFrame,
  type TourQuality,
  type TourRoom,
  type TourSize,
  type YawPitch,
} from './tour.js';
