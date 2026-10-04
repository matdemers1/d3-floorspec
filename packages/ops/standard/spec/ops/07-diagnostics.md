# 7. Diagnostics

A rejected batch carries diagnostics in the shape of Core §10.2. When the batch failed before
validation, they are `FS-OPS-` diagnostics; when the result was invalid, they are the result's
Core diagnostics (1.2.3). The first failure ends the transaction: an applier reports the
diagnostics of the step that failed, and nothing from later steps.

## 7.1 The catalogue

| Code | Condition | Elements | Rule |
|---|---|---|---|
| `FS-OPS-001` | the request is malformed: not a batch, an empty batch, an unknown operation, a missing or unknown member | — | 1.1.1 |
| `FS-OPS-002` | the document the batch applies to is not valid | — | 1.2.1 |
| `FS-OPS-003` | a reference resolves to nothing: an unknown ID, a selector with no match, a member that is not there | the referring element, if any | 2.2.1, 2.3.1, 3.3.1, 4.5.1 |
| `FS-OPS-004` | a selector matches more than one element | every match | 3.3.1 |
| `FS-OPS-005` | an operation names an ID already in use or retired | — | 1.5.2 |
| `FS-OPS-006` | a removal is blocked by elements that depend on it | the blocked element and its dependents | 2.2.1 |
| `FS-OPS-007` | a selector needs faces on a level that has none to give | the level | 3.4.1 |
| `FS-OPS-008` | a composite does not apply: a side missing, oblique or jogged; a wall between two rooms removed without `keep` | the room or wall | 4.4.1, 4.7.1 |
| `FS-OPS-009` | an opening straddles a junction that planarization inserts | the opening | 5.2.1 |
| `FS-OPS-010` | a lock names elements that do not exist, or walls that are not parallel | the lock's elements | 6.1.1 |
| `FS-OPS-011` | the result breaks a lock | the lock's elements | 6.1.2 |
| `FS-OPS-012` | a length, point or vector string does not match the grammar | — | 3.1.1 |

Each diagnostic's `location.pointer` points into the request — `/batch/3/wall` — so the person or
agent who sent it can see which operation, and which member of it, failed.

An applier MUST report a rejection with the code this table gives for the first failure, and with exactly the elements it lists. {#FS-OPS-7.1.1 MUST}
