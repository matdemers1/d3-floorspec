# Agent eval — 100.0% (36/36)

**harness self-check (scripted reference agent — not a measurement of Claude).**

| | |
|---|---|
| Agent | scripted reference solutions through the MCP shim |
| Commit | `c2213e716ce8be712de3a018e964c38e1d95fb30` |
| Started | 2026-10-05T00:12:31.795Z |
| Finished | 2026-10-05T00:12:36.657Z |
| Tasks × runs | 36 × 1 |
| Pass rate per run | 100.0% (min 100.0%, max 100.0%) |
| Flaky tasks | none |
| Per task, on average | 1.8 tool calls, 1.2 ops committed, 0.00 rejected batches, 0.7 renders, 0 s |
| Note | after merging main 8de2ba7 (revised Ops 0.1 applier) |

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
| 002 Move the kitchen window a foot east | move-opening | pass | 1 | 0 | 1 |
| 003 36-inch door centred between kitchen and bedroom | add-opening | pass | 1 | 0 | 1 |
| 004 How big is the living room | read | pass | 0 | 0 | 0 |
| 005 Split the living room to make a study | split-room | pass | 2 | 0 | 1 |
| 006 Add a window to the kitchen (no size or wall given) | ambiguous | pass | 0 | 0 | 0 |
| 007 Which room the front door opens into | read | pass | 0 | 0 | 0 |
| 008 Slide the bedroom door south | move-opening | pass | 1 | 0 | 1 |
| 009 Grow the kitchen into the living room | resize-room | pass | 1 | 0 | 1 |
| 010 Which rooms have no window | read | pass | 0 | 0 | 0 |
| 011 Move the bath window toward the east end | move-opening | pass | 1 | 0 | 1 |
| 012 32-inch door from kitchen to hall | add-opening | pass | 1 | 0 | 1 |
| 013 Make the bedroom bigger (which one, how much?) | ambiguous | pass | 0 | 0 | 0 |
| 014 Widen the hall–living cased opening to 6 ft | resize-opening | pass | 2 | 0 | 1 |
| 015 Take out the bedroom 2 door | remove-opening | pass | 1 | 0 | 1 |
| 016 Primary bedroom 18 inches longer to the north | resize-room | pass | 1 | 0 | 1 |
| 017 Add a second floor on the same footprint | create-level | pass | 5 | 0 | 1 |
| 018 Widen the laundry into the bath | move-wall | pass | 1 | 0 | 1 |
| 019 How many exterior doors | read | pass | 0 | 0 | 0 |
| 020 4-foot window centred on the laundry's east wall | add-opening | pass | 1 | 0 | 1 |
| 021 Fix the empty-space diagnostic: name the closet | fix-diagnostic | pass | 1 | 0 | 1 |
| 022 Move the back door north | move-opening | pass | 1 | 0 | 1 |
| 023 Great room 3 feet wider on the west | resize-room | pass | 1 | 0 | 1 |
| 024 Split the great room with a cased opening | split-room | pass | 5 | 0 | 1 |
| 025 Make the kitchen opening bigger (by how much?) | ambiguous | pass | 0 | 0 | 0 |
| 026 Move the primary suite's closet 2 feet east | move-walls | pass | 4 | 0 | 1 |
| 027 36-inch door centred between kitchen and dining | add-opening | pass | 1 | 0 | 1 |
| 028 Move the upstairs bath wall into the bath | move-wall | pass | 1 | 0 | 1 |
| 029 Total bedroom area upstairs | read | pass | 0 | 0 | 0 |
| 030 Deepen the powder room into the foyer | resize-room | pass | 2 | 0 | 1 |
| 031 3-foot window on bedroom 2's west wall | add-opening | pass | 1 | 0 | 1 |
| 032 Split a pantry off the kitchen | split-room | pass | 2 | 0 | 1 |
| 033 Swap the kitchen window for a 4-foot one | resize-opening | pass | 2 | 0 | 1 |
| 034 Add an 8-foot basement level | create-level | pass | 1 | 0 | 1 |
| 035 Is there a bathroom downstairs | read | pass | 0 | 0 | 0 |
| 036 Which bedroom walls are exterior | read | pass | 0 | 0 | 0 |

## Failures

None.

