# packages/mcp

The D3 Floorspec MCP server (MCP 2026-07-28, `@modelcontextprotocol/server` 2.1.0), mounted by the
API at `/mcp` through `createFloorspecMcpHandler`.

Eleven tools: `floorspec_describe` (the room-centric summary in `src/summary`), `floorspec_query`,
`floorspec_apply`, `floorspec_propose`, `floorspec_propose_layouts` (the brief laid out by
`@floorspec/layout-solver` on the server, one pending changeset per candidate), `floorspec_accept`, `floorspec_reject`,
`floorspec_validate`, `floorspec_findings`, `floorspec_render`, `floorspec_export`; the resource
`floorspec://<project>/model`; the prompt `design-partner`. `apply` and `propose` take the Floorspec
Ops 0.2 union (`src/ops-schema.ts`, hand-written from the spec; `test/ops-schema.test.ts` holds it,
host references included, to the vendored `schema/ops/0.2`): the program (`addProgramItem`,
`setAdjacency`, `removeAdjacency`, `setRoomBrief`, `addRoom`'s `brief`) and hosted extension elements
(`placeElement`, `moveElement`) beside the 0.1 operations. `test/program.test.ts` drives a brief and
a device through `floorspec_apply` against the reference applier. Every tool that takes a changeset
takes its name or its ID.

`tools/list` is kept small (`src/tool-schema.ts`): shared shapes are `$defs`, the union is spelled out
once (on `apply`; `propose` names the ops and validates its batch against the same union), and a
test fails past 25 KB (about 23 KB with the 0.2 union, up from 19.3 KB). Rejections agents are known to hit get a one-line `Hint:` beside the coded
diagnostics (`src/hints.ts`).
There is no tool that runs code (FLR-REQ-058), and `test/server.test.ts` walks every schema to keep
it so.

The tools reach the server through a `FloorspecClient` — in production `HttpFloorspecClient`, which
calls the REST API with the caller's own credential.
