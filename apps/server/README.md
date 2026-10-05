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

## Live events (FLR-T-3.5)

`GET /api/projects/:id/events` is a `text/event-stream` (a session, or a `read` token; 404 to anyone
else). Events say that something moved, never carry the model:

| Event | Data |
|---|---|
| `ready` | `{ resumed, replayed }`: live, after any replay |
| `head` | `{ head: 'main', hash, seq, kind, authorKind, author, changeset }`: main moved |
| `changeset` | `{ id, name, status, change, head, hash, base, ops, createdBy, mergeMode }`; `change` is `opened`, `appended`, `accepted`, `rejected` or `replay-failed` |
| `resync` | `{ reason }`: what was missed cannot be replayed; re-fetch |

Publishing is `pg_notify('floorspec_events', …)` inside the transaction that made the change
(`MutationResult.events`), so Postgres delivers it on commit, in commit order, and never for a
rollback; each api process holds one `LISTEN` connection (`src/events/hub.ts`) and fans out to its
own subscribers. IDs are `<epoch>-<n>`; `Last-Event-ID` (or `?lastEventId=`) replays from a
bounded per-project ring or answers `resync`. Heartbeat comment every 20 s; streams end after
15 min so the client re-authorises on reconnect. Stop the hub before the HTTP server
(`eventHubOf(app).close()`), or open streams keep it alive.

## Checks

`GET /api/projects/:id/validate`, `/findings` (empty until rule packs, Phase 6), `/render`
(plan PNG via the worker's `renderPlanPng`, in-process; `?changeset=` draws it ghosted against its
base; 3D answers 501) — each on main or `?changeset=<id>`.

## Assets (FLR-T-8.2)

`POST /api/projects/:id/assets` takes an image's own bytes as the body (`X-Asset-Name`: its file
name, percent-encoded; JSON is refused with 415): sniffed as PNG, JPEG, WebP or KTX2 from the
bytes, its EXIF/XMP/text metadata removed losslessly, stored once by SHA-256 under `ASSET_DIR`
(`ab/cd/<sha256>`, written to a temporary name and renamed), and claimed by the project in
`project_assets`. 201 with the entry the document's `assets` should carry — `path`
`assets/<sha256>.<ext>`, `sha256`, `mediaType`, `byteLength` — plus `width` and `height`. A session,
or a `write` or `agent` token. It changes no model: the editor adds the asset in an Ops batch.
`GET …/assets` lists the model's assets and the project's uploads; `GET …/assets/:sha256` serves the
bytes (`immutable`, `nosniff`, a sandboxing CSP; `?download` as an attachment) to a project that
uploaded them, or whose model names a digest its owner uploaded — 404 to anyone else, digest or not.
`src/assets/store.ts` is the adapter (`FsAssetStore`; `MemoryAssetStore` when `ASSET_DIR` is unset
outside production).

Furniture (FLR-T-8.3) uploads through the same route with `?as=`: `?as=model` takes a glTF 2.0
model — `.glb`, or a `.gltf` whose buffers and images are embedded `data:` URIs; a model naming
another file, or requiring a glTF extension, is refused with the reason (`src/assets/gltf.ts`) — and
`?as=symbol` a plan symbol, a PNG (stripped as above) or an SVG. An SVG is never stored as sent: a
strict tokenizer keeps an allowlist of drawing (shapes, paths, text, gradients, clips, `#`
references) and drops scripts, handlers, `foreignObject`, style sheets and every outside
reference; a DOCTYPE is refused. A clean file keeps its bytes (and so a library symbol its
digest); one that lost anything is written again, and `stripped` says what went
(`src/assets/svg.ts`). Without `as` an upload is a texture, as before.

## MCP (FLR-T-2.6)

`POST /mcp`: MCP 2026-07-28 (and 2025-era clients, statelessly) via `@floorspec/mcp`. Bearer
only — an API token, or a D3 Auth access token whose audience is `<PUBLIC_URL>/mcp`, resolved to a
linked account and treated as an agent. Each tool call loops back to this API with the caller's own
`Authorization` header. RFC 9728 metadata at `/.well-known/oauth-protected-resource` and
`/.well-known/oauth-protected-resource/mcp`. Claude's connector is registered in D3 Auth from
`deploy/floorspec-mcp.d3auth.json`, and `<PUBLIC_URL>/mcp` must be in D3 Auth's `RESOURCE_SERVERS`.
