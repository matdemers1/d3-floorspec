# D3 Floorspec

The reference implementation of **[Floorspec](https://github.com/matdemers1/floorspec)**, an open
standard for describing houses as code. Design a house with Claude: you draw and decide, Claude
proposes changes over MCP, and every change is validated, attributed and reviewable. 2D first, 3D,
materials and furniture are derived from the same model, and advisory building-code findings
come with citations.

**New here?** Start with the public pages — no account needed:

- **The standard:** [d3cloud.io/floorspec](https://d3cloud.io/floorspec) — Floorspec Core 0.4,
  Ops 0.4 and Rules 0.2, all drafts.
- **The playground:** [d3cloud.io/floorspec/playground](https://d3cloud.io/floorspec/playground) —
  drop a Floorspec document or `.floorspec` package and the reference engine validates it and draws
  it in 2D and 3D in your browser. Nothing is uploaded.

## Status

**Deployed, by invitation only**, at [floorspec.d3cloud.io](https://floorspec.d3cloud.io) on a home
server, deployed by Shipyard from GHCR `sha-` images. There is no public sign-up: the operator
account comes from first-run setup and every other account from an invite, and Sign in with
D3 Auth links to an existing account rather than creating one. To use it without an invite,
self-host it (below).

Project `FLR` in [Foreman](https://foreman.d3cloud.io) is the plan of record. As of 2026-10-06:

- **Complete:** Phases 0 Foundation, 1 Core Spec — Walls & Rooms, 3 The 2D Editor, 4 Program,
  Bubbles & Layouts, 5 Extensions & Building Systems, 7 3D — Floors, Roofs & Stairs,
  8 Materials, Furniture & Options, 10 Publication, 11 Advanced Geometry.
- **Built, waiting on the owner:**
  - Phase 2 (Ops & the Agent Bet): the agent eval has run — 94.4% (68/72) over 36 tasks, above
    the 80% kill threshold. The scheduled CI run needs an `ANTHROPIC_API_KEY` secret.
  - Phase 9 (Interop & Handoff): glTF/USDZ and IFC4 export and IFC round-trip import are built
    and validate; the owner checks them in AR and in IFC viewers.
  - Phase 12 (Hardening & 1.0): failure alerts need the mail relay's credentials on the host.
- **Blocked on a person by design:**
  - Phase 6 (Code Rules): every real building-code rule must be certified by someone who read the
    cited section and paraphrased it themselves (`rules/CONTRIBUTING.md`), and Claude cannot
    certify. The engine, profiles, findings and an example pack are built.
  - Floorspec 1.0 waits on the owner's own house being fully modelled, and on an owner decision
    about the second implementation: ratification needs two implementations by different
    maintainers.

## What is in the repository

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
| `evals/agent` | the 36-task agent eval that tests the project's kill criterion |

Self-hosted with Docker Compose (`deploy/compose.yml`; locally, `./deploy/dev-env.sh` then
`docker compose -f deploy/compose.yml -f deploy/compose.dev.yml up -d --build --wait` and open
http://127.0.0.1:3400 — the first visit creates the operator account). Apache-2.0. Findings are not a plan review; the
authority having jurisdiction decides.

## Your house, your data

**No telemetry.** D3 Floorspec sends nothing anywhere you did not configure. The api and the
worker connect to PostgreSQL (`DATABASE_URL`) and, only if you turn on Sign in with D3 Auth, to
your D3 Auth issuer (`D3AUTH_ISSUER`: discovery, token exchange, its signing keys). Rule packs are
read from a local directory (`RULE_PACKS_DIR`); plans are rendered in-process; the editor is
served by your own api and loads nothing from anywhere else. No analytics, no crash reporting, no
update checks. `apps/server/test/no-telemetry.test.ts` holds this: it boots the app under an
interception layer on every way Node reaches the network — sockets, DNS, UDP, `fetch`,
`http(s)` — drives every surface (setup, projects, edits, changesets, layouts, assistants,
findings, renders, the live stream, tokens, exports, MCP), and fails on any connection beyond
those services.

**Free export, always.** Every project exports as a valid Floorspec document — the canonical
`model.json` (`GET /api/projects/:id/model.json`, the editor's download, and the MCP tool
`floorspec_export`) — at any time and whatever state it is in: empty, mid-edit, with changesets
pending, on an older draft of the standard, even holding a document today's engine would reject;
through a session or any kind of token, read-only included. So does the `.floorspec` package —
`model.json` and every texture it uses, one ZIP that unpacks to the identical folder
(`GET /api/projects/:id/package`, the Export dialog's **Floorspec model**, and
`floorspec package`/`floorspec unpack`; layout in `packages/package/README.md`) — and any valid
document or package imports as a new project. Nothing in the app is paid for, so nothing is ever
held back. The same test file checks each of those states. A deleted project
is deleted for everyone, its owner included; export it first.

Self-hosting from a clean machine: [docs/self-host.md](docs/self-host.md).
