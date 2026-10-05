# Agent eval — 66.7% (2/3)

**BELOW the 80% tripwire (FLR-REQ-055) — measured by the proxy method: Claude subagents via the fs-mcp CLI, not `claude -p`.**

| | |
|---|---|
| Agent | **proxy — Claude subagents via fs-mcp CLI, not `claude -p`** (scripted calls (self-check, not Claude)) |
| Commit | `885d3952f9c27adc73666a6dc553ce94035d139d` |
| Started | 2026-10-05T00:20:56.830Z |
| Finished | 2026-10-05T00:21:10.850Z |
| Tasks × runs | 3 × 1 |
| Pass rate per run | 66.7% (min 66.7%, max 66.7%) |
| Flaky tasks | none |
| Per task, on average | 2.3 tool calls, 2.0 ops committed, 0.33 rejected batches, 0.3 renders, 10 s |
| Note | proxy — Claude subagents via fs-mcp CLI, not `claude -p` |

## By category

| Category | Passed |
|---|---|
| add-opening | 0/1 |
| read | 1/1 |
| split-room | 1/1 |

## Tasks

| Task | Category | Run 1 | Ops | Rejected | Renders |
|---|---|---|---|---|---|
| 003 36-inch door centred between kitchen and bedroom | add-opening | **FAIL** | 1 | 0 | 0 |
| 010 Which rooms have no window | read | pass | 0 | 0 | 0 |
| 024 Split the great room with a cased opening | split-room | pass | 5 | 1 | 1 |

## Failures

### 003 36-inch door centred between kitchen and bedroom — run 1

> Add a 36-inch door in the middle of the wall between the kitchen and the bedroom.

Scored the agent's changeset.

- **openingAdded** — O1 is 5' 3" off centre

Tools: apply×1; 1 batch(es) sent, 0 rejected.

Reply (last 600 characters): Added a 36 in door in the kitchen-bedroom wall. 

