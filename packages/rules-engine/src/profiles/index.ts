/**
 * Jurisdiction-profile helpers for a profile builder (FLR-T-6.8): the edition catalogue as data,
 * field-by-field problems, the canonical form and what Rules 10.2 and 10.5 make of a profile.
 */
export { CODES, DOMAINS, codeInfo, domainOf, domainRank, domainTitle, latestEdition, type CodeInfo, type Domain } from './catalogue.js';
export {
  adoptionViews,
  caretRange,
  editionsLine,
  inForceSummary,
  isDate,
  isDefaultProfile,
  normalizeProfile,
  parseProfile,
  profileProblems,
  sameProfile,
  serializeProfile,
  startingProfile,
  withdrawals,
  type AdoptionStatus,
  type AdoptionView,
  type ParsedProfile,
  type ProfileProblem,
  type Withdrawal,
} from './builder.js';
