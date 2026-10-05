# packages/rules-engine — `@floorspec/rules-engine`

The reference evaluator of **Floorspec Rules 0.1** (FLR-T-6.2): rule packs evaluated against a Core
document under a jurisdiction profile, giving advisory findings that name the edition they were
checked against. Rules advise and never block (FLR-ADR-011, FLR-REQ-098); nothing here ever says
that a design meets a code.

Isomorphic like the engine it is built on (FLR-ADR-010): no Node built-ins, no clock, no randomness.
Every measure is exact and rounded once (Rules 4.3); a report is serialized as Core 9.2 step 2
writes a value, so two runs — in Node or in a browser — give the same bytes.

```ts
import { findingsFor, evaluate, callMeasures, serialize, DEFAULT_PROFILE } from '@floorspec/rules-engine';

// After a commit (never inside one): the report for the committed document.
const report = findingsFor(document, profile /* undefined → "Model Codes (latest)" */, packs);
report.findings;      // advisory findings, each "… may not meet <code> <edition> <section> (…)"
report.evaluated;     // what was checked — empty when no packs are installed
report.notEvaluated;  // what was not, and why: profile, invalid, deferred, edition, withdrawn, extension
report.coverage;      // what the packs say they address
report.notice;        // "Floorspec findings are advisory. …" — show it wherever findings are shown

// The conformance shape: a request (JSON text or value) and the evaluator's known extensions.
evaluate(documentBytes, requestBytes, { knownExtensions: registryBytes });
callMeasures(document, { calls: [{ target: { kind: 'room', id: 'R1' }, measure: 'roomNetArea' }] });
```

## Layout

| | |
|---|---|
| `src/evaluate.ts` | the pipeline of Rules 1.3: request, profile, document, packs, the profile's packs and amendments, each rule; the report |
| `src/evaluation.ts` | measure results, tests, subjects, candidates, exceptions, findings, shapes, messages |
| `src/typing.ts` | 3.9: well typed, deferred, which extensions a rule reads |
| `src/measures/` | the measure library, one module per chapter: `rooms.ts` (5), `openings.ts` (6), `elements.ts` (7), `walllines.ts` (8); `library.ts` holds them and the deferred measures of 4.8 |
| `src/model.ts` | what measures read: faces, the room of an element (4.4), members with defaults (4.5), frames |
| `src/exact.ts` | rationals and ℚ(√m) for local coordinates; exact rounding |
| `src/display.ts` | 9.6 |
| `src/structure.ts` | the schema validators, the assurance pattern, the catalogue, the notice, the default profile |
| `src/generated/` | `pnpm generate`: standalone ajv validators and types from `standard/schema/rules/0.1`, member defaults from the engine's vendored registry |
| `standard/` | `pnpm sync-standard`: schema, conformance suite and spec text, pinned in `standard/LOCK.json` |

## Commands

```bash
pnpm --filter @floorspec/rules-engine sync-standard   # vendor from ../floorspec (clean checkout)
pnpm --filter @floorspec/rules-engine generate        # then regenerate validators, types, defaults
pnpm --filter @floorspec/rules-engine conformance     # the Rules 0.1 suite, byte for byte (Node)
pnpm --filter @floorspec/rules-engine test            # every test (Node)
pnpm --filter @floorspec/rules-engine test:browser    # measure tests and the suite in Chromium
pnpm --filter @floorspec/rules-engine perf            # timings over the suite's largest document and a grid
```

Net clear openings and door clear widths are deferred in Rules 0.1 (4.8). When a later Rules draft
defines them over the net-clear data Core 0.2 is gaining, each is one more entry of
`src/measures/openings.ts` and leaves `DEFERRED`.
