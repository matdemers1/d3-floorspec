# Agent eval — 94.4% (68/72)

**at or above the 80% tripwire.**

| | |
|---|---|
| Agent | Claude Code 2.1.278 (Claude Code), model `sonnet` |
| Commit | `69f1082f50f31c89e80cbb2c641e0e7faa9eb766` |
| Started | 2026-10-05T01:35:02.428Z |
| Finished | 2026-10-05T01:45:02.975Z |
| Tasks × runs | 36 × 2 |
| Pass rate per run | 94.4%, 94.4% (min 94.4%, max 94.4%) |
| Flaky tasks | 024, 031 |
| Per task, on average | 4.4 tool calls, 1.2 ops committed, 0.10 rejected batches, 1.0 renders, 5.4 turns, 24 s |
| Total cost | $7.62 |
| Note | official run after MCP tool fixes |

## By category

| Category | Passed |
|---|---|
| add-opening | 7/10 |
| ambiguous | 6/6 |
| create-level | 4/4 |
| fix-diagnostic | 2/2 |
| move-opening | 8/8 |
| move-wall | 4/4 |
| move-walls | 2/2 |
| read | 14/14 |
| remove-opening | 2/2 |
| resize-opening | 4/4 |
| resize-room | 10/10 |
| split-room | 5/6 |

## Tasks

| Task | Category | Run 1 | Run 2 | Ops | Rejected | Renders |
|---|---|---|---|---|---|---|
| 001 Bump the kitchen out to the east | resize-room | pass | pass | 1/1 | 0/0 | 1/1 |
| 002 Move the kitchen window a foot east | move-opening | pass | pass | 1/1 | 0/0 | 1/1 |
| 003 36-inch door centred between kitchen and bedroom | add-opening | pass | pass | 1/1 | 0/0 | 1/1 |
| 004 How big is the living room | read | pass | pass | 0/0 | 0/0 | 0/0 |
| 005 Split the living room to make a study | split-room | pass | pass | 3/2 | 0/0 | 2/1 |
| 006 Add a window to the kitchen (no size or wall given) | ambiguous | pass | pass | 1/1 | 0/0 | 1/1 |
| 007 Which room the front door opens into | read | pass | pass | 0/0 | 0/0 | 0/0 |
| 008 Slide the bedroom door south | move-opening | pass | pass | 1/1 | 0/0 | 1/1 |
| 009 Grow the kitchen into the living room | resize-room | pass | pass | 1/1 | 0/0 | 1/1 |
| 010 Which rooms have no window | read | pass | pass | 0/0 | 0/0 | 0/0 |
| 011 Move the bath window toward the east end | move-opening | pass | pass | 1/1 | 0/0 | 1/1 |
| 012 32-inch door from kitchen to hall | add-opening | **FAIL** | **FAIL** | 1/1 | 0/0 | 1/1 |
| 013 Make the bedroom bigger (which one, how much?) | ambiguous | pass | pass | 0/0 | 0/0 | 0/0 |
| 014 Widen the hall–living cased opening to 6 ft | resize-opening | pass | pass | 2/2 | 1/1 | 2/2 |
| 015 Take out the bedroom 2 door | remove-opening | pass | pass | 1/1 | 0/0 | 1/1 |
| 016 Primary bedroom 18 inches longer to the north | resize-room | pass | pass | 1/1 | 0/0 | 1/1 |
| 017 Add a second floor on the same footprint | create-level | pass | pass | 6/5 | 0/0 | 3/2 |
| 018 Widen the laundry into the bath | move-wall | pass | pass | 1/1 | 0/0 | 1/1 |
| 019 How many exterior doors | read | pass | pass | 0/0 | 0/0 | 0/0 |
| 020 4-foot window centred on the laundry's east wall | add-opening | pass | pass | 1/1 | 0/0 | 1/1 |
| 021 Fix the empty-space diagnostic: name the closet | fix-diagnostic | pass | pass | 1/1 | 0/0 | 1/1 |
| 022 Move the back door north | move-opening | pass | pass | 1/1 | 0/0 | 1/1 |
| 023 Great room 3 feet wider on the west | resize-room | pass | pass | 1/1 | 0/0 | 1/2 |
| 024 Split the great room with a cased opening | split-room | pass | **FAIL** | 4/3 | 0/2 | 2/3 |
| 025 Make the kitchen opening bigger (by how much?) | ambiguous | pass | pass | 2/0 | 1/0 | 2/0 |
| 026 Move the primary suite's closet 2 feet east | move-walls | pass | pass | 4/4 | 0/0 | 2/1 |
| 027 36-inch door centred between kitchen and dining | add-opening | pass | pass | 1/1 | 0/0 | 1/1 |
| 028 Move the upstairs bath wall into the bath | move-wall | pass | pass | 1/1 | 0/0 | 2/2 |
| 029 Total bedroom area upstairs | read | pass | pass | 0/0 | 0/0 | 0/0 |
| 030 Deepen the powder room into the foyer | resize-room | pass | pass | 2/2 | 1/1 | 2/2 |
| 031 3-foot window on bedroom 2's west wall | add-opening | **FAIL** | pass | 1/1 | 0/0 | 2/2 |
| 032 Split a pantry off the kitchen | split-room | pass | pass | 2/2 | 0/0 | 1/1 |
| 033 Swap the kitchen window for a 4-foot one | resize-opening | pass | pass | 2/2 | 0/0 | 1/1 |
| 034 Add an 8-foot basement level | create-level | pass | pass | 1/1 | 0/0 | 1/1 |
| 035 Is there a bathroom downstairs | read | pass | pass | 0/0 | 0/0 | 0/0 |
| 036 Which bedroom walls are exterior | read | pass | pass | 0/0 | 0/0 | 0/0 |

## Failures

### 012 32-inch door from kitchen to hall — run 1

> Add a 32-inch door from the kitchen into the hall, centred in the wall between them.

Scored the agent's changeset.

- **openingAdded** — 0 new door(s) in I2, wanted 1; other new openings: O1 (opening) in I2

Tools: describe×2, findings×1, propose×1, query×2, validate×1; 1 batch(es) sent, 0 rejected.

Reply (last 600 characters): exists in the project's library, I added it as a sized opening (width/height set directly) rather than tied to a `doorType` fill — it has no swing/hinge assigned yet, so the plan currently shows it as a plain opening rather than a swinging door leaf. Let me know if you'd like a specific swing direction (e.g., swinging into the Hall) and I'll add that, or if you'd rather I match an existing door type (30" or 36") instead of a custom 32" size. This is pending in the changeset **"Add 32\" door between Kitchen and Hall"** — you'll need to accept it in D3 Floorspec for it to land in the main plan.

### 031 3-foot window on bedroom 2's west wall — run 1

> Add a 3-foot window centred on the west wall of bedroom 2.

Scored the agent's changeset.

- **openingAdded** — 0 new window(s) in W4857, wanted 1; other new openings: O1 (opening) in W4857

Tools: describe×1, findings×1, propose×1, query×2, render×1, validate×1; 1 batch(es) sent, 0 rejected.

Reply (last 600 characters): Validates clean, no findings issues. I've added a new 3' 0"-wide window (O1) centered on Bedroom 2's west wall, 4' 0" tall with a 3' 0" sill, matching the sill/head height of the room's existing south window. This is sitting in the pending changeset **"Add 3' window to west wall of Bedroom 2"** — it'll need to be accepted in D3 Floorspec before it's part of the main plan.

### 012 32-inch door from kitchen to hall — run 2

> Add a 32-inch door from the kitchen into the hall, centred in the wall between them.

Scored the agent's changeset.

- **openingAdded** — 0 new door(s) in I2, wanted 1; other new openings: O1 (opening) in I2

Tools: apply×1, describe×1, findings×1, query×1, validate×1; 1 batch(es) sent, 0 rejected.

Reply (last 600 characters): Added a 32" door (6'8" tall), centered in the 4'0" wall between Kitchen and Hall — the render confirms it's placed correctly and the plan validates clean, no findings raised. This lands in the pending changeset **"Add kitchen-hall door"**; it's not in the live plan until you accept it in D3 Floorspec.

### 024 Split the great room with a cased opening — run 2

> Split the great room into a living room and a dining room with a wall running north–south, 10 feet east of the west wall, and put a 6-foot cased opening centred in the new wall. The east part is the dining room.

Scored the agent's changeset.

- **openingAdded** — 0 new opening(s) in W4849, wanted 1

Tools: apply×2, describe×1, propose×1, query×1; 3 batch(es) sent, 2 rejected.
- rejected: Rejected: nothing changed. the batch was rejected and nothing changed \| - FS-INV-201 error: LIV's anchor is on a location line, not in a bounded face. [LIV] \| - FS-INV-201 error: R1's anchor is on a location line, not in a bounded face. [R1] \| { \|   "status": 422, \|   "type": "/problems/ops-rejected",
- rejected: Rejected: nothing changed. the batch was rejected and nothing changed \| - FS-SCH-001 error: /rooms/LIV/anchor/0: must be integer \| - FS-SCH-001 error: /rooms/LIV/anchor/1: must be integer \| { \|   "status": 422, \|   "type": "/problems/ops-rejected",

Reply (last 600 characters): The wall is in and the room split correctly — Living (west, 9' 3¾" × 23' 3¾") and Dining (east, 9' 7½" × 23' 3¾"), new wall W4849 between them. The "Great room" name still shows on LIV; I'll rename it to "Living room" and add the opening. Before I add the cased opening: did you want it at standard door height (6' 8"), or full-height (floor to the 9' ceiling) for a more open connection between the two rooms?


## Analysis (added after the run)

The first official run (`claude -p`, Sonnet, owner's machine) clears the FLR-REQ-055 tripwire at
94.4% in both runs. The four failures are tool friction, not spatial reasoning:

- **012 ×2, 031 run 1 — a door or window became an empty cased opening.** The requested size (32",
  3') was not in the project's type library, so Claude called `addOpening` with a width and height
  but no `fill`. An opening without a door or window type is a cased opening, and nothing in the
  tool result said so. Fix: the vocabulary and `addOpening` description say it plainly, and
  propose/apply results flag an opening created with no type.
- **024 run 2 — gave up mid-task to ask a question.** A new wall ran through the room's anchor
  (FS-INV-201), then `setProperty /anchor` with length strings was refused (FS-SCH-001: values are
  not resolved). After two rejections Claude asked about the opening's height instead of finishing.
  Fix: diagnostic hints for both cases.

Both fixes ship with the Ops 0.2 port of `packages/mcp`; the next run measures them.
