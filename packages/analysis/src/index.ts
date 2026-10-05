/**
 * @floorspec/analysis — the advisory energy and comfort estimate of a Floorspec document
 * (FLR-REQ-153, FLR-T-12.6). It reads the engine's evaluation and never changes a document; its
 * inputs live in the document's extras and change through Ops like anything else. Isomorphic
 * (FLR-ADR-010) and deterministic. Advisory, always: an estimate to compare options, never an
 * energy-code calculation and never a statement that a house meets a code (FLR-ADR-011's spirit).
 */
export * from './climate.js';
export * from './solar.js';
export * from './envelope.js';
export * from './inputs.js';
export * from './estimate.js';
export * from './format.js';
