/** The D3 Floorspec MCP server (MCP 2026-07-28), mounted by the API at `/mcp`. */
export const PACKAGE_NAME = '@floorspec/mcp';

export { createFloorspecServer, modelUri, SERVER_NAME, SERVER_VERSION, TOOL_NAMES } from './server.js';
export { createFloorspecMcpHandler } from './handler.js';
export {
  FloorspecApiError,
  HttpFloorspecClient,
  type ApplyInput,
  type ChangesetView,
  type Committed,
  type FloorspecClient,
  type HttpClientOptions,
  type Model,
  type ProjectSummary,
  type RenderOptions,
} from './client.js';
export { Batch, Length, Lock, OP_NAMES, OpUnion, type OpInput } from './ops-schema.js';
export { DESIGN_PARTNER_PROMPT } from './prompts.js';
export { query } from './query.js';
export { formatFeetInches } from './units.js';
export * from './summary/index.js';
