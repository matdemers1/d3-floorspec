/**
 * @floorspec/assistant-staging — a non-normative staging assistant (FLR-T-13.11). Given a plan, it
 * dresses its rooms with the FS_furniture starter library's decor — rugs, art, lamps, plants,
 * textiles, window dressings, media, books and kitchen and bath accessories — placed by geometric
 * rules around the furniture already there, as one Floorspec Ops batch a person accepts or rejects
 * as a changeset (FLR-ADR-016).
 *
 * Isomorphic like the engine (FLR-ADR-010) and deterministic: the same plan gives the same batch,
 * byte for byte.
 */
export const PACKAGE_NAME = '@floorspec/assistant-staging';

export { proposeStaging, usedIds, type StagedItem, type StagingOptions, type StagingProposal } from './propose.js';
export { readStaging, type StagingRoom } from './room.js';
export { PlanError } from '@floorspec/assistant-electrical';
