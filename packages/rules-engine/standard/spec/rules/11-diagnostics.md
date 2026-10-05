# 11. Diagnostics

Rules diagnostics are about the inputs of an evaluation — the request, its profile and its packs —
never about the design: what is wrong with a design is a finding (chapter 9), and what is wrong with
a document is a Core diagnostic (Core §10). A rules diagnostic is a JSON object:

| Member | Type | Meaning |
|---|---|---|
| `code` | string | the code from the catalogue (11.1) |
| `severity` | `"error"`, `"warning"` or `"info"` | as the catalogue gives it |
| `packIndex` | integer | for a diagnostic about a pack (`FS-RULES-004` to `FS-RULES-006`): the pack's position in the request's `packs`, from 0 |
| `pack`, `rule` | strings | for a diagnostic about a rule (`FS-RULES-007` to `FS-RULES-009`): its pack's name and its ID; for `FS-RULES-010` and `FS-RULES-011`, the pack's name, and for `FS-RULES-011` the rule ID, as the profile gives them |

A report's diagnostics are compared exactly, as its findings are (9.8): they carry no message, so
that two evaluators report the same bytes.

## 11.1 The catalogue

| Code | Severity | Condition | Members | Then | Rule |
|---|---|---|---|---|---|
| `FS-RULES-001` | error | the request is not a well-formed JSON text, or does not match the request schema | — | nothing is evaluated | 1.1.1 |
| `FS-RULES-002` | error | the profile does not match the profile schema, adopts one code twice with one date, names one pack twice, or its text matches the assurance pattern | — | nothing is evaluated | 10.1.1 |
| `FS-RULES-003` | error | the document is not valid | — | nothing is evaluated | 1.2.1 |
| `FS-RULES-004` | error | a pack does not match the pack schema; once for each | `packIndex` | the pack is not evaluated | 2.1.1 |
| `FS-RULES-005` | error | a pack that matches the schema shares its name with another that does; once for each such pack | `packIndex` | the pack is not evaluated | 2.2.1 |
| `FS-RULES-006` | error | a pack that matches the schema has text that matches the assurance pattern | `packIndex` | the pack is not evaluated | 2.5.1 |
| `FS-RULES-007` | error | a rule is not well typed | `pack`, `rule` | the rule is not evaluated | 3.9.1 |
| `FS-RULES-008` | info | a rule uses a deferred measure | `pack`, `rule` | the rule is not evaluated | 3.9.2 |
| `FS-RULES-009` | info | a rule in force reads an extension that is not evaluated for the document | `pack`, `rule` | the rule is not evaluated | 3.10.1 |
| `FS-RULES-010` | warning | the profile names a pack that no usable pack satisfies; once for each | `pack` | — | 10.4.1 |
| `FS-RULES-011` | warning | an applying amendment withdraws a rule no usable pack has; once for each | `pack`, `rule` | — | 10.5.1 |

An evaluator MUST report each condition of this catalogue, once for each occurrence, as a diagnostic with exactly the code, severity and members it gives, and no other diagnostic. {#FS-RULES-11.1.1 MUST}

A pack can be reported with both `FS-RULES-005` and `FS-RULES-006`; a rule is reported with at most
one of `FS-RULES-007`, `FS-RULES-008` and `FS-RULES-009`, in that order of precedence (1.3, step 6).
None of these is a finding, and none says anything about the design.

## 11.2 Related

FLR-ADR-011, FLR-REQ-093, FLR-REQ-097. Core §10 (diagnostics of documents), each official
extension's diagnostics chapter (diagnostics of extension data).
