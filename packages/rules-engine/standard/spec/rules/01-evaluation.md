# 1. Evaluation

An evaluator is given three things: a **document**; the **extensions** it implements and the
**known extensions** its validator is configured with (Core §12.2), exactly as a Core validator is;
and an **evaluation request**, which carries the rule packs, the profile and the units to display
values in. It returns a **report** (chapter 9): the findings, what was and was not evaluated, the
packs' coverage and the notice that findings are not a plan review.

## 1.1 The evaluation request

The request is a JSON text (Core §9.1) whose value is an object:

| Member | Type | Default | Meaning |
|---|---|---|---|
| `floorspecRules` | `"0.1"` | — (always present) | the draft of Floorspec Rules the request targets |
| `packs` | array of rule packs (chapter 2) | — (always present) | the packs to evaluate; it may be empty |
| `profile` | profile (chapter 10) | the default profile (10.6) | the jurisdiction profile to evaluate under |
| `units` | `"imperial"` or `"metric"` | `"imperial"` | how the report displays lengths and areas (9.6) |

The request schema is `schema/rules/0.1/request.schema.json`, published at
`https://d3cloud.io/floorspec/schema/rules/0.1/request.schema.json`. It checks the request's own
members; each pack and the profile are checked by their own schemas later (2.1, 10.1), so that one
malformed pack does not stop the others.

An evaluator MUST evaluate a request only when it is a well-formed JSON text, as Core §9.1 defines one, whose value matches the request schema; for any other request it MUST report `FS-RULES-001` and evaluate nothing else. {#FS-RULES-1.1.1 MUST}

## 1.2 The document

An evaluator reads the document as a Core 0.3 reader (Core §1.2.6), with the official extensions
it implements: an extension is **evaluated** for a document exactly when that extension's own
specification says its validator evaluates it (each official extension's §1.2) — for the official
extensions at 0.1.0, when the document declares `"0.2"` or `"0.3"` and uses the extension at a
version the evaluator both implements and knows.

An evaluator MUST evaluate rules only for a valid document — one that a Core 0.3 validator implementing the same extensions, configured with the same known extensions, reports valid (Core §10.1) — and for any other document MUST report `FS-RULES-003` and no finding. {#FS-RULES-1.2.1 MUST}

A document is valid or not before any rule is read: rules never make one valid or invalid (1.5).

## 1.3 Order of evaluation

An evaluator takes these steps, in this order:

1. **The request** (1.1): `FS-RULES-001`.
2. **The profile** (chapter 10): the request's `profile`, or the default profile; `FS-RULES-002`.
3. **The document** (1.2): `FS-RULES-003`.
4. **The packs** (chapter 2): each pack's schema (`FS-RULES-004`); then, among the packs that match
   it, shared names (`FS-RULES-005`) and wording (`FS-RULES-006`). A pack with any of these is not
   evaluated; the others are **usable**.
5. **The profile's packs and amendments** (10.4, 10.5): `FS-RULES-010` and `FS-RULES-011`.
6. **Each rule** of each usable pack the profile selects (10.4), in turn: its typing
   (`FS-RULES-007`), then its measures (`FS-RULES-008`), then whether it is in force (10.3, 10.5),
   then whether the extension data it reads is evaluated (`FS-RULES-009`). A rule that passes
   every check is **evaluated**.
7. **Each evaluated rule's subjects** (chapter 3), and their findings (chapter 9).

An evaluator MUST take these steps in this order, and MUST NOT take any later step when step 1, 2 or 3 reports a diagnostic. {#FS-RULES-1.3.1 MUST}

A diagnostic of steps 4 to 6 stops only the pack or the rule it names; the rest of the request is
evaluated.

## 1.4 A function of its inputs

Evaluation is **pure**: the same document, extensions and request always give the same report, to
the byte (9.8). A profile is an input like any other, so changing the profile — another edition in
force, a later `asOf` date, an amendment — and evaluating again is how findings follow a change of
jurisdiction (10.7).

The report MUST be a function of the document, the extensions the evaluator implements, its known extensions and the request alone: an evaluator MUST NOT let the order in which the request lists packs, the order in which a pack lists rules, the time at which it runs, or anything outside these inputs change it. {#FS-RULES-1.4.1 MUST}

## 1.5 Advice, never a gate

Findings are advice about a valid design. They are evaluated after a document is committed, on the
committed document, and nothing waits for them.

Evaluating rules MUST NOT change the document, and a finding MUST NOT change whether the document is valid, its diagnostics, its content hash or anything it derives. {#FS-RULES-1.5.1 MUST NOT}

Findings and diagnostics are separate streams: a finding MUST NOT be reported as a Core or extension diagnostic, and its severity MUST be one of the finding severities of 3.11, never a diagnostic's `error`, `warning` or `info`. {#FS-RULES-1.5.2 MUST}

> [!note] Rules never block an edit
> An editor evaluates rules on the document an Ops batch committed (Ops §1.3) — after the commit,
> never as a step of it. A batch that leaves a bedroom without an escape window commits exactly as
> one that does not; the finding follows. This is FLR-REQ-098, and it holds because no step of an
> Ops transaction reads a rule.
