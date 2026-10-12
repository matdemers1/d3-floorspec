/**
 * @floorspec/mesh/sky — the sun, the sky and the lawn every view of a house shares (FLR-T-13.4,
 * FLR-T-13.9): the NOAA solar position, the sky presets over CC0 HDRI maps, image-based light as
 * spherical harmonics, the exposure a sky is seen at, and the procedural lawn. Isomorphic.
 */
export * from './solar.js';
export * from './sky.js';
export * from './grass.js';
export { decodeHdr, encodeHdr, type HdrImage } from './hdr.js';

/** The file each map is kept in, beside this package's `sky/` (`@floorspec/mesh/sky/<file>`). */
export const SKY_MAP_FILES = { clear: 'clear.hdr', overcast: 'overcast.hdr', dusk: 'dusk.hdr', night: 'night.hdr' } as const;
export { GLASS_F0, GLASS_IOR, glassAt, glassFresnel, paneTransmission } from './glass.js';
