# Floorspec Rules

The normative specification of advisory building-code rules — **Draft 0.1**: rule records, the
named-measure library, findings and jurisdiction profiles. It evaluates Floorspec Core 0.2
documents (and so Core 0.1 documents) with the official extensions, and is versioned independently
of Core and Ops (FLR-ADR-008). Findings are advice: they never make a document invalid, never stop
an edit, and never say that a design meets a code (FLR-ADR-011).

| Chapter | |
|---|---|
| [0. Conventions](00-conventions.md) | what Rules is, conformance classes, relation to Core and Ops, the RASE shape, what this draft does not define, code text |
| [1. Evaluation](01-evaluation.md) | the evaluation request, the document, the order of evaluation, a pure function, advice never a gate |
| [2. Rule packs](02-packs.md) | the pack object, names, the CC BY 4.0 licence, coverage, wording and the assurance pattern |
| [3. Rule records](03-rules.md) | citation, paraphrase, applicability, selection, requirement, exceptions, tests, typing, extension data, severity, provenance |
| [4. Measures](04-measures.md) | targets, types, exactness, the room of an element, extension members and matches, measure results, deferred measures |
| [5. Measures of rooms](05-rooms.md) | function, net area, least width, circulation, neighbours, elements in a room |
| [6. Measures of openings](06-openings.md) | kind, size as drawn, heights above the floor, outside |
| [7. Measures of elements and envelopes](07-elements.md) | members, room, heights, protection, envelopes as declared, obstructions, clear depth in front, overlaps |
| [8. Wall lines, receptacles, circuits and levels](08-wall-lines.md) | the wall line of a room, receptacle reach, wall run between receptacles, circuits, levels |
| [9. Findings and the report](09-findings.md) | the report, findings, measured conditions, location, wording, display, order, serialization, the notice |
| [10. Jurisdiction profiles](10-profiles.md) | adoptions and editions in force, rules in force, packs, amendments, the default profile |
| [11. Diagnostics](11-diagnostics.md) | the FS-RULES catalogue |

Schemas: `schema/rules/0.1/` (request, pack, rule, profile, report, finding), published at
`https://d3cloud.io/floorspec/schema/rules/0.1/`. Conformance: `conformance/rules/0.1/` — a
document, a request and the expected report, byte for byte; and measure tests. Rule packs
themselves live in [`rules/`](../../rules/).

Every normative statement ends with a tag such as `{#FS-RULES-3.9.1 MUST}`. `pnpm statements`
extracts them; `pnpm coverage` fails if a `MUST` or `MUST NOT` has no conformance test.
