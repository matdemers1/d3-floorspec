# packages/mcp

The D3 Floorspec MCP server (MCP 2026-07-28, `@modelcontextprotocol/server` 2.1.0), mounted by the
API at `/mcp` through `createFloorspecMcpHandler`.

Ten tools: `floorspec_describe` (the room-centric summary in `src/summary`), `floorspec_query`,
`floorspec_apply`, `floorspec_propose`, `floorspec_accept`, `floorspec_reject`,
`floorspec_validate`, `floorspec_findings`, `floorspec_render`, `floorspec_export`; the resource
`floorspec://<project>/model`; the prompt `design-partner`. `apply` and `propose` take the Floorspec
Ops 0.1 union (`src/ops-schema.ts`, hand-written from the spec until `schema/ops/0.1` is vendored).
There is no tool that runs code (FLR-REQ-058), and `test/server.test.ts` walks every schema to keep
it so.

The tools reach the server through a `FloorspecClient` — in production `HttpFloorspecClient`, which
calls the REST API with the caller's own credential.
