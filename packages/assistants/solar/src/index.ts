/**
 * @floorspec/assistant-solar — a non-normative solar assistant (FLR-T-16.1). Given a plan, it ranks its
 * roof faces by a kW's typical year after shade, lays FS_energy arrays on the most productive ones
 * within their setbacks, sized to a target, with an inverter and a rapid-shutdown initiator on a
 * circuit, as one Floorspec Ops batch a person accepts or rejects as a changeset. An estimate to compare
 * layouts — never a guarantee, and never a code check.
 *
 * Isomorphic like the engine (FLR-ADR-010) and deterministic: the same plan and options give the same
 * batch, byte for byte.
 */
export const PACKAGE_NAME = '@floorspec/assistant-solar';

export {
  proposeSolar,
  houseUseOf,
  equatorRotation,
  SolarError,
  DEFAULT_MODULE,
  DEFAULT_RACK,
  DEFAULT_CUTOFF,
  BASE_USE,
  HEATING_COP,
  COOLING_COP,
  BREAKER_MARGIN,
  type SolarOptions,
  type SolarTarget,
  type SolarProposal,
  type FacePlan,
  type ProposedArray,
} from './propose.js';
