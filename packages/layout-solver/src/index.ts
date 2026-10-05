/**
 * @floorspec/layout-solver — a non-normative layout solver (Core 0.2 §11.6; FLR-REQ-074,
 * FLR-REQ-075). It turns a program and its adjacency graph into ranked candidate layouts, each a
 * Floorspec Ops batch that draws walls, separators, rooms, doors and windows on a level; ranked by
 * brief fit, circulation and the engine's findings, measured on the document each batch commits.
 *
 * Isomorphic like the engine it is built on (FLR-ADR-010), and deterministic: the same input gives
 * the same candidates, byte for byte.
 */
export const PACKAGE_NAME = '@floorspec/layout-solver';

export { solve, type SolveOptions, type Candidate, type CandidateRoom } from './solve.js';
export { toChangesetProposals, MAX_BATCH, MAX_CHANGESET_NAME, type ChangesetProposal, type ProposalOptions } from './changesets.js';
export { SolverError } from './document.js';
export type { ScoreBreakdown, ScoreDetail } from './score.js';
export type { Program, ProgramItem, Adjacency, Unplaced } from './program.js';
export type { Family } from './layout.js';
export { GRID, SQ_BU_PER_SQ_FT, BU_PER_FOOT, BU_PER_INCH } from './units.js';
