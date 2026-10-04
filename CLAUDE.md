# CLAUDE.md — D3 Floorspec (reference implementation)

Foreman project **FLR**. Start every session with `/start-development FLR`; the plan of record is in
Foreman, not in this repo. Key documents: `foreman://FLR/overview`, `foreman://FLR/architecture`,
`foreman://FLR/data_model`, `foreman://FLR/api_contract`, `foreman://FLR/ux_flows`,
`foreman://FLR/test_strategy`. The standard lives in `../floorspec` (same Foreman project).

## Stack
TypeScript everywhere except `workers/ifc` (Python 3.13 + IfcOpenShell). Node 22, pnpm 10, Turborepo.
React 19 + `@d3cloud/ui` 1.5 chrome; custom plan canvas on DS tokens; three.js r186 + R3F 9 for 3D.
PostgreSQL 16 stores canonical Floorspec documents (JSONB keyed by content hash) + an append-only op log.
MCP 2026-07-28 via `@modelcontextprotocol/server` 2.x at `/mcp`. Dual login (app-native + D3 Auth).
Deployed to the Zima by Shipyard from GHCR `sha-` images — never by SSH.

## Rules that are not negotiable
- **Every change is a Floorspec Op.** Nothing writes documents directly (FLR-ADR-008).
- **The engine is the same package in browser, server, MCP and CLI** (FLR-ADR-010). No Node-only APIs in packages/engine.
- **Exactness:** lengths are integers in 1/1280 mm (FLR-ADR-004). Floats never reach normative outputs.
- **The conformance suite is the oracle,** pinned from `../floorspec` (FLR-ADR-009).
- **Agent tokens write changesets, never main** (FLR-ADR-016).
- **Rules advise, never block; never print "compliant"** (FLR-ADR-011).
- **No arbitrary code-execution MCP tool** (FLR-REQ-058). **No telemetry.**
- **The agent eval gates the project:** below 80% after tool fixes → stop and re-plan (FLR-REQ-055).
- UI is designed in Figma ("Floorspec (FLR)" board) before it is built (FLR-T-3.1).
- No time estimates anywhere. No Co-Authored-By lines in commits.

## Commands
```bash
pnpm install                 # pnpm 10.34.5, Node 22 (.nvmrc); supply-chain policy in pnpm-workspace.yaml
pnpm build                   # turbo: every package and app
pnpm lint && pnpm typecheck  # web lint includes @d3cloud/ui's d3-check-usage guard
pnpm test                    # unit tests, every package
pnpm test:python             # workers/ifc (needs workers/ifc/.venv — see its README)

# Integration tests need Postgres 16 and a database name ending in _test (created and migrated
# by the suite itself):
docker run -d --name flr-pg -e POSTGRES_USER=floorspec -e POSTGRES_PASSWORD=floorspec \
  -p 127.0.0.1:55440:5432 postgres:16
DATABASE_URL=postgresql://floorspec:floorspec@127.0.0.1:55440/floorspec_test pnpm test:integration

# Development: api on :3400 (migrates on boot), Vite on :5173 proxying /api and /auth to it
cp .env.example .env   # then fill KEK and PEPPER with `openssl rand -base64 32`
pnpm --filter @d3-floorspec/server dev
pnpm --filter @d3-floorspec/web dev

# The whole stack as it runs on the Zima, built from this checkout
./deploy/dev-env.sh
docker compose -f deploy/compose.yml -f deploy/compose.dev.yml up -d --build --wait
```

## How the server is put together
- **Routes are declared through `Routes` (`apps/server/src/http/routes.ts`)**, never with
  `router.post` and friends. `mutate()` runs the handler in a transaction and writes the audit row
  in it; every route needs a signed-in account unless it says `access: 'public'`; every
  `:projectId` path checks ownership first and answers 404. The audit walk
  (`test/integration/audit.test.ts`) and the isolation suite (`test/integration/isolation.test.ts`)
  enumerate the app's registry and fail on a route their tables do not cover — add the route to
  the table when you add the route.
- `versions`, `op_log` and `audit_log` refuse UPDATE and DELETE in the database (triggers in the
  init migration). A project is deleted softly.
- `apps/server/src/model/canonical.ts` is **temporary**: when `@floorspec/engine` exports
  `canonicalize`/`contentHash` (FLR-T-1.4), import those and delete it.
- Sign in with D3 Auth never creates an account; accounts come from first-run setup (operator)
  and invites only. Redirect URI: `<PUBLIC_URL>/auth/oidc/callback`; scopes
  `openid profile email d3:roles`.

The engine (`packages/engine`) is isomorphic: its build loads no Node types and ESLint refuses
`node:` imports, `Buffer` and `process` there.

Bumping `@d3cloud/ui`: read the lockfile-integrity trap in `../foreman/CLAUDE.md` — the lockfile
entry for the release tarball must carry `integrity: sha512-…` or the image build fails.
