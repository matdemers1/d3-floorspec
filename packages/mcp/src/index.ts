/** The D3 Floorspec MCP server (MCP 2026-07-28), mounted by the API at `/mcp`. */
export const PACKAGE_NAME = '@floorspec/mcp';

export { createFloorspecServer, layoutsText, modelUri, SERVER_NAME, SERVER_VERSION, TOOL_NAMES } from './server.js';
export { createFloorspecMcpHandler } from './handler.js';
export {
  FloorspecApiError,
  HttpFloorspecClient,
  type ApplyInput,
  type ChangesetView,
  type Committed,
  type FloorspecClient,
  type Finding,
  type FindingCitation,
  type Findings,
  type HttpClientOptions,
  type LayoutCandidate,
  type Layouts,
  type LayoutsInput,
  type Model,
  type ProjectSummary,
  type RenderOptions,
} from './client.js';
export { Batch, Length, Lock, OP_NAMES, OpUnion, type OpInput } from './ops-schema.js';
export { DESIGN_PARTNER_PROMPT } from './prompts.js';
export { CRITIQUE_CATEGORIES, CRITIQUE_PROMPT_NAME, CritiqueArgs, critiquePrompt, parseFocus, type CritiqueArguments, type CritiqueCategory } from './prompts/critique.js';
export { hintsFor, NEWEL_HINT, SET_PROPERTY_HINT, STAIR_04_HINT, TAPER_HINT, UPGRADE_HINT } from './hints.js';
export { ROOM_FUNCTIONS, ROOM_FUNCTION_MAPPINGS, ROOM_FUNCTIONS_TEXT } from './vocabulary.js';
export { query } from './query.js';
export { formatFeetInches } from './units.js';
export * from './summary/index.js';
