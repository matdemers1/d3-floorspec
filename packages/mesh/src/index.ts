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
export { pairedElements } from './paired.js';
export { surfaceGroups, tileCoordinates, type Surface, type SurfaceGroup, type TilePlacement } from './surfaces.js';
export { LANDSCAPE_ROLES, MODEL_ROLES, ROLE_LOOKS, type ModelRole, type RoleLook } from './roles.js';
export { discriminant, elementKind } from './models/kinds.js';
export { gableCladding } from './cladding.js';
export { PART_KINDS, UNITS_PER_METRE, type Box3, type Cladding, type HouseMesh, type MeshOptions, type MeshPart, type PartKind, type PartMesh, type PartStats, type Vec3, type DoorState } from './types.js';
export { ENVELOPE, envelope, openEnvelope, openingFrame, type LocalBox, type OpeningFrame } from './joinery.js';
export { DEFAULT_LUMENS, EXPOSURE_PER_NIT, kelvinColor, lightsOf, LUMENS_PER_WATT, WHITE_BALANCE, type FixtureLight } from './lights.js';
