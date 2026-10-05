# evals/agent — the agent eval

The project's kill criterion (FLR-REQ-054, FLR-REQ-055; FLR-T-2.9): Claude is given homeowner
requests against seeded houses, works through the D3 Floorspec MCP tools exactly as a person's
Claude Code would, and the **resulting model** is scored by assertions. Below 80% after tool fixes,
the project stops and re-plans.

## Run it

```bash
pnpm install && pnpm build          # the API, the stdio shim and the packages must be built
# Postgres 16 reachable; the harness drops and recreates its own *_test database
EVAL_DATABASE_URL=postgresql://floorspec:floorspec@localhost:55433/floorspec_eval_test \
  pnpm --filter @d3-floorspec/agent-eval eval [--tasks 001,002] [--runs 2] [--model sonnet] \
       [--concurrency 3] [--timeout 600] [--note "what changed since the last run"]

# The harness alone, with no model: plays each task's first reference solution through the same
# shim, token and changeset path. Its pass rate measures the harness, never Claude.
pnpm --filter @d3-floorspec/agent-eval eval --agent reference

pnpm --filter @d3-floorspec/agent-eval test   # scorer unit tests + the task self-check
```

Claude needs its own credentials: `ANTHROPIC_API_KEY` (then the run uses `--bare`, so no hooks,
plugins, memory or CLAUDE.md reach it), or a `claude auth login`. A Claude Code session started by
the desktop app cannot lend its sign-in to a nested `claude -p`; the harness strips those host
variables and, when the child cannot authenticate, **stops without a pass rate** (exit 3,
`ABORTED.txt`) rather than counting every task as failed.

Each run writes `results/<timestamp>/results.json` and `report.md` (pass rate per run, min/max,
flaky tasks, by category, per-task ops committed / rejected batches / renders, and every failure
with the assertion that failed, the rejections and the end of the reply). Transcripts and the API
log are written beside them and git-ignored.

## How a task runs

1. The built API (`apps/server/dist`) is started on a free loopback port against a fresh
   `*_test` database; the eval operator (`EVAL_OPERATOR` in `src/api.ts`, test values for the
   throwaway database) completes first-run setup.
2. Per task and run: a project, the seed applied to main as Floorspec Ops (a document seed is sent
   as `addElement` operations; its hash is checked), and an **agent** token — so every edit Claude
   makes lands in a pending changeset (FLR-ADR-016).
3. `claude -p "<prompt>" --output-format stream-json` with one MCP server, the stdio shim
   (`packages/mcp-stdio`) pointed at the API with that token; `--tools ""` (no Bash, Edit, Web),
   only the ten `mcp__floorspec__*` tools allowed, `--permission-mode dontAsk`, the plugin's
   `floorspec-design-partner` skill appended to the system prompt, an empty working directory, and
   a per-task timeout.
4. The model scored is the agent's newest pending changeset with edits in it — or main when it made
   none (a read-only question, or a request it rightly asked about). Main moving at all fails the
   task.

## Tasks

A task is `tasks/NNN-slug.json`: `{ id, title, category, prompt, seed, assertions, answer?, notes?,
references }`. `seed` names a file in `seeds/` — a Floorspec Core 0.1 document, or `{ "batches":
[...] }` applied in order to an empty document. Assertions (`src/types.ts`) are declarative and read
only the resulting model, measured with `@floorspec/engine` (validate, derive) and the room-centric
summary; each is written to accept **every** correct way of making the edit (any composite or
primitive, any ID, "centred" on the location line or either face, a replacement opening as well as a
moved one). Read-only tasks append one sentence asking for a final `ANSWER:` line, so they are
scored without a judge; ambiguous ones accept asking (nothing changed, a question in the reply) and,
where there is an obvious reading, making it.

Every task carries at least one scripted **reference** solution. `test/tasks.test.ts` proves, for
every task, that each reference passes every assertion and that doing nothing fails. A task or an
assertion is changed only with a written reason that it was **wrong** — never because it is hard.

Seeds: `three-room-house` (the conformance house), `two-bedroom-ranch`, `l-shaped-house` (from
`packages/mcp/test/fixtures`), and `two-storey-colonial` (two levels, ten rooms, written for the
eval as Ops batches).

| ID | Category | Seed | Prompt |
|---|---|---|---|
| 001 | resize-room | three-room-house | Bump the kitchen out 2 feet to the east. |
| 002 | move-opening | three-room-house | Move the kitchen window over 1 foot toward the east. |
| 003 | add-opening | three-room-house | Add a 36-inch door in the middle of the wall between the kitchen and the bedroom. |
| 004 | read | three-room-house | How many square feet is the living room? |
| 005 | split-room | three-room-house | Split the living room in two with a new wall running east–west, 7 feet north of the south wall, and make the southern part a study. |
| 006 | ambiguous | three-room-house | Add a window to the kitchen. |
| 007 | read | three-room-house | Which room does the front door open into? |
| 008 | move-opening | three-room-house | Slide the bedroom door 2 feet to the south. |
| 009 | resize-room | two-bedroom-ranch | Make the kitchen 2 feet bigger by pushing it into the living room. |
| 010 | read | two-bedroom-ranch | Which rooms don't have a window? |
| 011 | move-opening | two-bedroom-ranch | Move the bathroom window 1 foot toward the east end of its wall. |
| 012 | add-opening | two-bedroom-ranch | Add a 32-inch door from the kitchen into the hall, centred in the wall between them. |
| 013 | ambiguous | two-bedroom-ranch | Make the bedroom bigger. |
| 014 | resize-opening | two-bedroom-ranch | Widen the cased opening between the hall and the living room to 6 feet, keeping it centred where it is now. |
| 015 | remove-opening | two-bedroom-ranch | Take out the door between the hall and the second bedroom. |
| 016 | resize-room | two-bedroom-ranch | Make the primary bedroom 18 inches longer to the north. |
| 017 | create-level | two-bedroom-ranch | Add a second floor with the same exterior walls as the main floor. |
| 018 | move-wall | l-shaped-house | Make the laundry room 2 feet wider by moving the wall between it and the bathroom. |
| 019 | read | l-shaped-house | How many doors to the outside does the house have? |
| 020 | add-opening | l-shaped-house | Add a 4-foot wide window centred on the east wall of the laundry room. |
| 021 | fix-diagnostic | l-shaped-house | The plan check says there's an empty space with no room in it — it's the closet inside the primary suite. Fix that by making it a walk-in closet. |
| 022 | move-opening | l-shaped-house | Move the back door 2 feet to the north. |
| 023 | resize-room | l-shaped-house | Make the great room 3 feet wider on the west side. |
| 024 | split-room | l-shaped-house | Split the great room into a living room and a dining room with a wall running north–south, 10 feet east of the west wall, and put a 6-foot cased opening centred in the new wall. The east part is the dining room. |
| 025 | ambiguous | l-shaped-house | Make the kitchen opening bigger. |
| 026 | move-walls | l-shaped-house | Move the closet in the primary suite 2 feet to the east. |
| 027 | add-opening | two-storey-colonial | Add a 36-inch door centred in the wall between the kitchen and the dining room. |
| 028 | move-wall | two-storey-colonial | Upstairs, move the wall between the bathroom and the hall 1 foot into the bathroom. |
| 029 | read | two-storey-colonial | What's the total floor area of the bedrooms upstairs, in square feet? |
| 030 | resize-room | two-storey-colonial | Make the powder room 2 feet deeper by taking the space from the foyer. |
| 031 | add-opening | two-storey-colonial | Add a 3-foot window centred on the west wall of bedroom 2. |
| 032 | split-room | two-storey-colonial | Split the kitchen to make a pantry: a wall running north–south, 5 feet in from the east wall, and the part east of it becomes the pantry. |
| 033 | resize-opening | two-storey-colonial | Swap the kitchen window for a bigger 4-foot one, centred in the same spot. |
| 034 | create-level | two-storey-colonial | Add a basement level, 8 feet tall, under the first floor. |
| 035 | read | two-storey-colonial | Is there a bathroom on the first floor? |
| 036 | read | three-room-house | Which sides of the bedroom are outside walls? |

Not covered yet, as planned: devices on walls by side (Phase 5) and fixing a Floorspec Rules finding
(Phase 6 — task 021 fixes a validator diagnostic instead).

## Run log

Every run, and every tool fix with the run that motivated it, is recorded here.

| Date | Run | Result | Notes |
|---|---|---|---|
| 2026-10-04 | Harness self-check, `--agent reference`, commit 003a8e2 | 36/36 | End to end through the API, shim and changesets |
| 2026-10-04 | Harness self-check after merging main 8de2ba7 (revised Ops 0.1 applier) | 36/36 | `results/2026-10-05T00-12-31-794Z-reference/` |
| 2026-10-04 | Harness self-check after the three tool fixes below (303271e) | 36/36 | `results/2026-10-05T00-15-07-442Z-reference/` |
| 2026-10-04 | Claude, `--tasks 001` | **not run** | `claude -p` could not authenticate from the build environment (a desktop-app session; no `ANTHROPIC_API_KEY`, CLI not logged in). No pass rate exists yet. |

### Tool fixes

Made before the first Claude run, each found while writing the reference solutions — so the first
measured run already includes them, and they are listed here rather than credited to a run:

1. **MCP op schemas match the vendored Ops 0.1 schema.** After the revised spec, `addJunction`,
   `addSeparator`, `drawSeparator`, `addOpening` and `addRoom` refused `name`/`extensions`/`extras`
   the applier accepts, and `setProperty` accepted a missing `value`. A test now holds every
   operation to `packages/ops/standard/schema/ops/0.1`.
2. **`floorspec_describe` takes a room name.** Its schema says "ID or name"; a name threw an
   internal error. Unknown rooms and levels now get a tool error with a hint.
3. **The design-partner prompt says where a batch must end.** It told agents to put everything in
   one batch, but walls drawn in a batch join the plan only when it ends, so a face-reading selector
   after a `drawWall` is refused with `FS-OPS-007 … junction J26 lies inside W4865` — splitting a
   room and putting a door in the new wall in one batch fails (tasks 005, 024, 032).

Candidates the first real run should confirm or dismiss (not fixed: no evidence yet that agents
trip on them):

- The summary gives opening positions "from the wall's start" but not which way each wall runs;
  "move it toward the east end" needs `floorspec_query` for the wall's direction (tasks 002, 011,
  022).
- A resize that leaves an opening hanging past its shortened wall is refused with `FS-INV-302 DFO
  extends beyond the length of W4855` and no fix operation (task 030).
- `FS-OPS-007`'s message names Core 5.3.2 but not the remedy (split the batch) — the message lives
  in `@floorspec/ops`, outside the eval's write scope.
