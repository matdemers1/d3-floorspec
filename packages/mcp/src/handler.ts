import { createMcpHandler, type McpHttpHandler, type McpRequestContext } from '@modelcontextprotocol/server';
import type { FloorspecClient } from './client.js';
import { createFloorspecServer } from './server.js';

/**
 * The Streamable HTTP handler for `/mcp`: a fetch-shaped handler that serves the 2026-07-28
 * revision and, statelessly, 2025-era clients. A fresh server per request, with a client built
 * from that request's credential — nothing is kept between requests, so nothing leaks between
 * callers.
 */
export function createFloorspecMcpHandler(clientFor: (ctx: McpRequestContext) => FloorspecClient, onerror?: (error: Error) => void): McpHttpHandler {
  return createMcpHandler((ctx) => createFloorspecServer({ client: clientFor(ctx) }), {
    legacy: 'stateless',
    ...(onerror === undefined ? {} : { onerror }),
  });
}
