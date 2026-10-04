# D3 Floorspec

The reference implementation of **[Floorspec](https://github.com/matdemers1/floorspec)**, an open
standard for describing houses as code. Design a house with Claude: you draw and decide, Claude
proposes changes over MCP, and every change is validated, attributed and reviewable. 2D first, 3D,
materials and furniture are derived from the same model, and advisory building-code findings
come with citations.

> Status: planning complete, scaffolding only. Spec: https://d3cloud.io/floorspec

| Package | Role |
|---|---|
| `packages/engine` | isomorphic TypeScript engine: validate, canonicalize, derive (walls, rooms, areas) |
| `packages/ops` | Floorspec Ops: reference grammar, transactions, batches, locks |
| `packages/rules-engine` | Floorspec Rules: measures, profiles, advisory findings |
| `packages/mcp`, `packages/mcp-stdio` | MCP server (spec 2026-07-28) and stdio shim |
| `packages/render2d`, `packages/mesh` | SVG plan renderer; 3D meshes via manifold-3d |
| `packages/cli` | `floorspec validate` and friends |
| `apps/server`, `apps/web`, `apps/worker` | API + SSE + /mcp; editor; job worker |
| `workers/ifc` | Python IfcOpenShell worker (separate process, LGPL) |
| `evals/agent` | the 30-task agent eval that tests the project's kill criterion |

Self-hosted with Docker Compose. Apache-2.0. No telemetry. Findings are not a plan review; the
authority having jurisdiction decides.
