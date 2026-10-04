# apps/server

The D3 Floorspec API: REST, auth, the op log and changesets, the MCP endpoint, and the editor's
statics. See `CLAUDE.md` at the repo root for how routes are declared and audited.

## Edits (FLR-T-2.4)

Every change is a Floorspec Ops request handed to an `Applier` (`src/ops/applier.ts`, the spec's
request and result types). The server never edits a document itself. A committed result becomes a
version (canonical JSON keyed by content hash, shared), an appended `op_log` row (author, batch,
`resolved`, `inverse`, created/removed IDs, before/after hashes) and a moved head, in one
transaction under a row lock on the project. `context.retired` comes from `retired_ids`.

| Route | |
|---|---|
| `POST /api/projects/:id/ops` | `{ batch, context?: { locks }, changeset? }` → 201 committed; 422 problem+json with the applier's diagnostics; 412 on a stale `If-Match` |
| `POST /api/projects/:id/undo`, `/redo` | appends the stored inverse of the newest edit still in effect (undo), or of the newest undo (redo) |
| `GET /api/projects/:id/versions/:hash` | canonical bytes of a version this project reached |
| `GET /api/projects/:id/history` | main's ops, newest first, with what undo and redo would invert next |

Until `@floorspec/ops` is wired in, the app runs `unavailableApplier` (503); tests use
`test/support/fake-applier.ts`.

## Tokens and changesets (FLR-T-2.5)

Per-project API tokens (`/api/tokens`, session only): `read`, `write` (commits to main as the
person), `agent` (writes named pending changesets on scratch heads `cs/<id>`, never main). Only the
SHA-256 is stored; the secret is shown once. Routes say which tokens they accept with
`{ token: 'read' | 'propose' | 'write' }`; without it a route is for a person's session only.

| Route | |
|---|---|
| `GET/POST /api/projects/:id/changesets` | list; propose `{ name, batch? }` (opens, or appends to the pending one of that name) |
| `GET /api/projects/:id/changesets/:cs`, `…/model.json` | a changeset and its log; its scratch head's document |
| `POST /api/projects/:id/changesets/:cs/accept` | fast-forward when main has not moved, else replay the original batches onto main; a replay failure is 409 with diagnostics and merges nothing |
| `POST /api/projects/:id/changesets/:cs/reject` | discards the scratch head |

Accept and reject need a person: a session, or that person's write token — never an agent.

## Checks

`GET /api/projects/:id/validate`, `/findings` (empty until rule packs, Phase 6), `/render`
(plan PNG via the worker's `renderPlanPng`, in-process; `?changeset=` draws it ghosted against its
base; 3D answers 501) — each on main or `?changeset=<id>`.

## MCP (FLR-T-2.6)

`POST /mcp`: MCP 2026-07-28 (and 2025-era clients, statelessly) via `@floorspec/mcp`. Bearer
only — an API token, or a D3 Auth access token whose audience is `<PUBLIC_URL>/mcp`, resolved to a
linked account and treated as an agent. Each tool call loops back to this API with the caller's own
`Authorization` header. RFC 9728 metadata at `/.well-known/oauth-protected-resource` and
`/.well-known/oauth-protected-resource/mcp`. Claude's connector is registered in D3 Auth from
`deploy/floorspec-mcp.d3auth.json`, and `<PUBLIC_URL>/mcp` must be in D3 Auth's `RESOURCE_SERVERS`.
