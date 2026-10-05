/**
 * @floorspec/assistant-electrical — a non-normative electrical layout assistant (FLR-T-5.8,
 * FLR-REQ-090). Given a plan, it proposes receptacles along wall runs, GFCI and AFCI, switches at
 * room entries, ceiling lights and the circuits that group them, as one Floorspec Ops batch a
 * person accepts or rejects as a changeset. Its heuristics are Floorspec's own defaults, every one
 * configurable, and it never says a design meets a code: that is a rule's to advise, with a citation.
 *
 * Isomorphic like the engine (FLR-ADR-010) and deterministic: the same plan and defaults give the
 * same batch, byte for byte.
 */
export const PACKAGE_NAME = '@floorspec/assistant-electrical';

export { DEFAULTS, withDefaults, type ElectricalDefaults } from './defaults.js';
export { proposeElectrical, analyseGaps, runGaps, fillRun, switchAt, type ElectricalOptions, type ElectricalProposal, type Gap, type ProposedCircuit } from './propose.js';
export { readPlan, PlanError, type RoomPlan, type WallRun, type Entry } from './plan.js';
