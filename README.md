# D3 Floorspec

The reference implementation of **[Floorspec](https://github.com/matdemers1/floorspec)**, an open
standard for describing houses as code. Design a house with Claude: you draw and decide, Claude
proposes changes over MCP, and every change is validated, attributed and reviewable. 2D first, 3D,
materials and furniture are derived from the same model, and advisory building-code findings
come with citations.

> Status: Phase 0 (Foundation) built in the repo — monorepo, gated CI, PostgreSQL schema with an
> append-only op log and audit log, dual login (password + TOTP, Sign in with D3 Auth), invites,
> per-account isolation, and create a project → download its `model.json`. Not yet deployed.
> Spec: https://d3cloud.io/floorspec

| Package | Role |
|---|---|
| `packages/engine` | isomorphic TypeScript engine: validate, canonicalize, derive (walls, rooms, areas) |
| `packages/ops` | Floorspec Ops: reference grammar, transactions, batches, locks |
| `packages/rules-engine` | Floorspec Rules: measures, profiles, advisory findings |
| `packages/mcp`, `packages/mcp-stdio` | MCP server (spec 2026-07-28) and stdio shim |
| `packages/render2d`, `packages/mesh` | SVG plan renderer; 3D meshes via manifold-3d |
| `packages/dsl` | the relational authoring DSL (`kitchen 14x12 east-of dining` → Floorspec Ops) and its decompiler |
| `packages/cli` | `floorspec validate` and friends |
| `apps/server`, `apps/web`, `apps/worker` | API + SSE + /mcp (serves the editor's build); editor; job worker |
| `workers/ifc` | Python IfcOpenShell worker (separate process, LGPL) |
| `evals/agent` | the 30-task agent eval that tests the project's kill criterion |

Self-hosted with Docker Compose (`deploy/compose.yml`; locally, `./deploy/dev-env.sh` then
`docker compose -f deploy/compose.yml -f deploy/compose.dev.yml up -d --build --wait` and open
http://127.0.0.1:3400 — the first visit creates the operator account). Apache-2.0. No telemetry. Findings are not a plan review; the
authority having jurisdiction decides.
