# Agent eval — 100.0% (36/36)

**at or above the 80% tripwire — measured by the proxy method: Claude subagents via the fs-mcp CLI, not `claude -p`.**

| | |
|---|---|
| Agent | **proxy — Claude subagents via fs-mcp CLI, not `claude -p`** (Claude subagent, claude-opus-5-5) |
| Commit | `ac7aba2945d9d16467341eefedde33bb222444c9` |
| Started | 2026-10-05T00:26:15.690Z |
| Finished | 2026-10-05T00:29:30.328Z |
| Tasks × runs | 36 × 1 |
| Pass rate per run | 100.0% (min 100.0%, max 100.0%) |
| Flaky tasks | none |
| Per task, on average | 6.5 tool calls, 1.3 ops committed, 0.14 rejected batches, 1.4 renders, 246 s |
| Note | proxy — Claude subagents via fs-mcp CLI, not `claude -p` |

## By category

| Category | Passed |
|---|---|
| add-opening | 5/5 |
| ambiguous | 3/3 |
| create-level | 2/2 |
| fix-diagnostic | 1/1 |
| move-opening | 4/4 |
| move-wall | 2/2 |
| move-walls | 1/1 |
| read | 7/7 |
| remove-opening | 1/1 |
| resize-opening | 2/2 |
| resize-room | 5/5 |
| split-room | 3/3 |

## Tasks

| Task | Category | Run 1 | Ops | Rejected | Renders |
|---|---|---|---|---|---|
| 001 Bump the kitchen out to the east | resize-room | pass | 1 | 0 | 1 |
| 002 Move the kitchen window a foot east | move-opening | pass | 1 | 0 | 2 |
| 003 36-inch door centred between kitchen and bedroom | add-opening | pass | 1 | 0 | 2 |
| 004 How big is the living room | read | pass | 0 | 0 | 0 |
| 005 Split the living room to make a study | split-room | pass | 3 | 1 | 4 |
| 006 Add a window to the kitchen (no size or wall given) | ambiguous | pass | 1 | 0 | 2 |
| 007 Which room the front door opens into | read | pass | 0 | 0 | 1 |
| 008 Slide the bedroom door south | move-opening | pass | 1 | 0 | 2 |
| 009 Grow the kitchen into the living room | resize-room | pass | 1 | 0 | 1 |
| 010 Which rooms have no window | read | pass | 0 | 0 | 1 |
| 011 Move the bath window toward the east end | move-opening | pass | 1 | 0 | 1 |
| 012 32-inch door from kitchen to hall | add-opening | pass | 1 | 0 | 1 |
| 013 Make the bedroom bigger (which one, how much?) | ambiguous | pass | 0 | 0 | 1 |
| 014 Widen the hall–living cased opening to 6 ft | resize-opening | pass | 2 | 0 | 1 |
| 015 Take out the bedroom 2 door | remove-opening | pass | 1 | 0 | 1 |
| 016 Primary bedroom 18 inches longer to the north | resize-room | pass | 1 | 0 | 1 |
| 017 Add a second floor on the same footprint | create-level | pass | 5 | 0 | 2 |
| 018 Widen the laundry into the bath | move-wall | pass | 1 | 0 | 1 |
| 019 How many exterior doors | read | pass | 0 | 0 | 1 |
| 020 4-foot window centred on the laundry's east wall | add-opening | pass | 1 | 0 | 1 |
| 021 Fix the empty-space diagnostic: name the closet | fix-diagnostic | pass | 1 | 1 | 1 |
| 022 Move the back door north | move-opening | pass | 1 | 0 | 1 |
| 023 Great room 3 feet wider on the west | resize-room | pass | 1 | 0 | 1 |
| 024 Split the great room with a cased opening | split-room | pass | 5 | 1 | 3 |
| 025 Make the kitchen opening bigger (by how much?) | ambiguous | pass | 0 | 0 | 1 |
| 026 Move the primary suite's closet 2 feet east | move-walls | pass | 4 | 0 | 1 |
| 027 36-inch door centred between kitchen and dining | add-opening | pass | 1 | 0 | 1 |
| 028 Move the upstairs bath wall into the bath | move-wall | pass | 1 | 0 | 2 |
| 029 Total bedroom area upstairs | read | pass | 0 | 0 | 0 |
| 030 Deepen the powder room into the foyer | resize-room | pass | 2 | 1 | 3 |
| 031 3-foot window on bedroom 2's west wall | add-opening | pass | 1 | 0 | 2 |
| 032 Split a pantry off the kitchen | split-room | pass | 3 | 0 | 2 |
| 033 Swap the kitchen window for a 4-foot one | resize-opening | pass | 2 | 0 | 1 |
| 034 Add an 8-foot basement level | create-level | pass | 1 | 1 | 2 |
| 035 Is there a bathroom downstairs | read | pass | 0 | 0 | 1 |
| 036 Which bedroom walls are exterior | read | pass | 0 | 0 | 0 |

## Failures

None.


## Scorer correction (recorded, not hidden)

As first scored, this run was **97.2% (35/36)**: task 025 ("Make the kitchen opening bigger") failed
`asked` with "the reply asks no question". The agent did ask — "Tell me the width you want, and
whether you want it taller too, and I'll put it in a changeset" — without a question mark, and the
scorer only looked for `?`. The scorer now also accepts an explicit request for the missing decision
(`asksSomething`, with tests); the task and its assertions are unchanged. Re-scored: **100% (36/36)**.

## Tool friction the agents reported (to fix next)

1. The `tools` listing is ~108 KB, mostly the operation union — too big for a client to read whole.
2. `floorspec_describe`/`validate`/`findings`/`render` reject a changeset's *name*; only its ID works,
   though `floorspec_apply` accepts either.
3. Agents guessed `ops` for `floorspec_apply`'s `batch`; the prompt shows no example call.
4. Room `function` values (`study`, `closet` were tried) are not listed where agents look.
5. A cased opening needs an explicit `height`; the error does not say so.
6. `moveOpening` takes only an absolute `at`; "move it 1 ft east" needs arithmetic.
7. `addElement` content takes no length strings (`-8'` for a level's elevation) — a level-creating
   composite with lengths would help.
8. Removing the only door to a room raises nothing (circulation findings arrive in FLR-P-4).
