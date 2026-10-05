# registry

The Floorspec extension registry (FLR-ADR-007, Core chapter 12, from Core 0.2). Each extension has a
directory named after it, holding the **registry entry** of its current version:

```text
registry/<NAME>/extension.json     the registry entry
registry/<NAME>/spec.md            its specification, tagged in its own ID space ({#FS-ELEC-3.1.1 MUST})
registry/<NAME>/<short>.schema.json   its JSON Schema, whose $id is the entry's `schema` URL
```

A Proposal holds `proposal.md`, its rationale, instead; the specification, the schema and the suite
— `conformance/ext/<NAME>/<version>/` (`conformance/README.md`) — are required from Draft on, and
`evidence/` from Release Candidate on (Lifecycle, below). The spec site publishes a schema at
the URL its `$id` gives: `https://d3cloud.io/floorspec/schema/ext/<NAME>/<version>/<short>.schema.json`.

An entry matches [`schema/registry/0.1/extension.schema.json`](../schema/registry/0.1/extension.schema.json),
published at `https://d3cloud.io/floorspec/schema/registry/0.1/extension.schema.json`. Earlier
versions' entries stay recoverable from this repository's history and at their published URLs.

```json
{
  "name": "EXT_lighting",
  "version": "1.2.0",
  "status": "draft",
  "schema": "https://d3cloud.io/floorspec/schema/ext/EXT_lighting/1.2.0/lighting.schema.json",
  "title": "Lighting",
  "requires": { "FS_electrical": "^0.3.0" },
  "kinds": { "fixtures": { "title": "Light fixture", "fallback": { "symbol": true } } },
  "terms": { "roomFunctions": [] },
  "implementations": []
}
```

| Member | Meaning |
|---|---|
| `name` | the extension name: `FS_` (official, ratified), `EXT_` (multi-implementer) or a vendor prefix of 2 to 8 capitals or digits reserved here |
| `version` | the version this entry describes, `<major>.<minor>.<patch>` with an optional `-prerelease` |
| `status` | `proposal`, `draft`, `releaseCandidate` or `ratified` |
| `schema` | where the extension's JSON Schema for this version is published — an immutable URL |
| `requires` | the extensions it depends on, each with a version range (Core 12.3); never a cycle |
| `kinds` | the kinds of element it adds, each named by the collection that holds them in a document (Core 12.5), and which optional parts of a fallback — a glTF `asset`, a 2D `symbol` — every element of the kind must carry |
| `terms` | the room-function terms it adds (Core 4.2), without the `<NAME>:` prefix |
| `implementations` | software that implements it, by name and URL |

A validator configured with these entries as its **known extensions** checks that a document
using an extension at a known version also uses what it requires, at versions in range, and uses
only the collections and terms the entry names (Core 12.3, 12.4). A validator never needs the
registry to read a document: known extensions only add checks.

## Lifecycle

An extension moves through four statuses, each a value of the entry's `status`, and every move is
a pull request to this repository (FLR-REQ-138) made with the extension template
([`.github/PULL_REQUEST_TEMPLATE/extension.md`](../.github/PULL_REQUEST_TEMPLATE/extension.md):
add `?template=extension.md` to the pull request's URL). The Registry workflow
(`.github/workflows/registry.yml`) runs [`tools/registry-gates.ts`](../tools/registry-gates.ts) —
`pnpm registry:check` — on every push and pull request, and fails when an entry does not have
what its status asks or a change is not a step the lifecycle allows. Each status keeps the
requirements of the one before it.

| Status | What it means | What the gates require |
|---|---|---|
| **Proposal** (`proposal`) | an idea, with its name reserved | `extension.json` matching the entry schema, in a directory named after it; `proposal.md`, the written rationale — what it describes, why it is not Core or an existing extension, who means to implement it; a row in a table below |
| **Draft** (`draft`) | specified, and changing | `spec.md` with its statements tagged in an ID space of its own, its 1.1 table giving the entry's version and status; a schema file whose `$id` is the entry's `schema`, a URL with a `/<version>/` segment; a conformance suite at `conformance/ext/<NAME>/<version>/` with a test for every `MUST` and `MUST NOT` |
| **Release Candidate** (`releaseCandidate`) | specified and frozen, unless implementations find a problem | at least one implementation in `implementations`, each with **evidence** that it passed every test of the suite — or an owner's recorded **exception** |
| **Ratified** (`ratified`) | stable | at least two implementations, each with evidence of passing the suite as it is now, two of them **independent** (FLR-REQ-092; the entry schema itself refuses a ratified entry with fewer than two); from the commit that ratifies it, its schema files, its suite and every member of its entry but `implementations` are frozen |

**The oracle is not evidence.** The conformance oracle (`tools/oracle/ext/`) implements every
official extension, but it wrote the expected outputs its suite is checked against, so its passing
proves nothing about the suite. An implementation is software that someone uses: D3 Floorspec's
engine is one, and is listed for every official extension.

### Changes by pull request

On a pull request the gates also compare each entry with the pull request's base:

- a new extension, and a new version of an existing one, enters as a Proposal or a Draft;
- a version moves forward one status per pull request, and never back — a problem found in a
  Release Candidate or a Ratified version is fixed in a new version;
- a version only ever increases, and an entry is never removed: its name stays reserved, and its
  earlier versions stay recoverable from this repository's history and at their published URLs.

**A new Core draft, while Floorspec is 0.x (FLR-ADR-034).** When a Core draft is published that
changes nothing an official extension reads, that extension's Release Candidate may take it in
place, without a new version. The change is limited to three things:
- adding the draft to its 1.1 table and its 1.2.1 statement;
- one activation test showing a document of the new draft evaluated exactly as one of an earlier draft;
- its implementations' evidence, run again.

Nothing it validates or derives for an existing draft changes, and its schema is untouched. Anything
more is a new version. From 1.0 on, and for a Ratified version at any time, a new Core version is
always a new version of the extension.

A maintainer may allow anything else — two steps at once, a withdrawn proposal — by adding the
`registry-maintainer` label to the pull request, which re-runs the gates, and says why in it.

### Evidence

Evidence that an implementation passes a version's suite is a file
`registry/<NAME>/evidence/<slug>.json`, one for each implementation listed:

```json
{
  "implementation": { "name": "D3 Floorspec (@floorspec/engine)", "url": "https://github.com/matdemers1/d3-floorspec", "version": "ee6939f64cbfbf92f0ade7112cbe8df62744853a" },
  "maintainer": "matdemers1",
  "sharesCodeWith": [],
  "extension": "FS_plumbing",
  "extensionVersion": "0.1.0",
  "suite": { "commit": "441a066de5285ce7998e045e1add1bffa92d58a0", "tests": 39 },
  "result": { "passed": 39, "failed": 0 },
  "ran": "2026-10-05",
  "run": "https://github.com/matdemers1/d3-floorspec/actions/runs/37276088906",
  "command": "pnpm --filter @floorspec/engine conformance (test/extensions.node.test.ts)"
}
```

`implementation` is the entry's listing — the same `name` and `url` — with the version that ran;
`suite.commit` is the commit of this repository whose `conformance/ext/<NAME>/<version>/` it ran,
and `suite.tests` how many tests that suite held then, which the gates check against the commit;
`result` must be every test passed and none failed. `run` links a public run — a CI job — and
`ran` is its date. Evidence of a suite that has changed since its commit is **stale**: a warning for
a Release Candidate, which means the implementation should run the suite again, and an error for a
Ratified version.

Two implementations are **independent** when their evidence names different `maintainer`s and
neither lists the other in `sharesCodeWith` — the implementations it shares code with, a parser, a
geometry kernel, a port. The pull request that ratifies says how they came to be written
independently; the maintainers judge it.

### Exceptions

An owner may waive one gate for one version of one extension, by an entry in
[`exceptions.json`](exceptions.json) that names the decision and the condition that ends it. Only
the Release Candidate's implementation rule can be waived (`releaseCandidate.implementation`);
nothing of Ratified can. The gates fail when an exception names an entry or version that is not
there, or a rule that now passes, so an exception is removed when it ends. There are none: the
last, FS_furniture 0.1.0's, published as a Release Candidate with no implementation (FLR-T-8.3),
ended when D3 Floorspec's engine passed its suite and was listed.

### Who decides

The registry's maintainers — the owners of `registry/` in
[`.github/CODEOWNERS`](../.github/CODEOWNERS) — review every registry pull request, judge what the
gates cannot (that a proposal belongs in the registry, that a specification is clear, that two
implementations are independent, that a Release Candidate is ready to freeze), add the
`registry-maintainer` label, and record exceptions. The gates decide nothing a maintainer could not
see; they make sure nothing is merged that the lifecycle forbids.

Every kind an extension adds carries a fallback — a box, and optionally a glTF model and a 2D
symbol — so that a reader without the extension still shows that something is there. An extension
never changes what core data means (Core 12.7). Building systems — electrical, plumbing,
mechanical, low-voltage, structural, furniture — ship as first-party `FS_` extensions
(FLR-ADR-001).

## Official extensions

| Extension | Version | Status | What it describes | Statement IDs |
|---|---|---|---|---|
| [`FS_electrical`](FS_electrical/spec.md) | 0.1.0 | Release Candidate | panels, circuits, receptacles (GFCI, AFCI, USB, 240 V), switches and what they control, lights, smoke and CO alarms, EV chargers | `FS-ELEC-` |
| [`FS_plumbing`](FS_plumbing/spec.md) | 0.1.0 | Release Candidate | fixtures, water heaters, drains, cleanouts and logical stacks, with what drains where and where hot water comes from | `FS-PLMB-` |
| [`FS_mechanical`](FS_mechanical/spec.md) | 0.1.0 | Release Candidate | heating, cooling and ventilation equipment, air terminals, exhaust, gas appliances and gas sources, with fuel and combustion air | `FS-MECH-` |
| [`FS_lowvoltage`](FS_lowvoltage/spec.md) | 0.1.0 | Release Candidate | data, coax, phone and fibre outlets, doorbells, security devices, speakers, and the head-ends they are run to | `FS-LOWV-` |
| [`FS_furniture`](FS_furniture/spec.md) | 0.1.0 | Release Candidate | furniture, appliances and casework, each with a glTF model, a plan symbol and clearance envelopes — a refrigerator's door swing, the access beside a bed — with a starter library ([`library/`](FS_furniture/library/), CC0 1.0) | `FS-FURN-` |
| [`FS_structural`](FS_structural/spec.md) | 0.1.0 | Draft | bearing and shear flags, framing (material, system, member size, spacing), floor spans and headers, recorded on walls, openings, slabs, rooms' floors and roofs for handoff to an engineer — never a structural design or a check of one | `FS-STRC-` |

All six list one implementation, D3 Floorspec's engine, with evidence of its passing their
suites at e5fd4ca in a public CI run (`<NAME>/evidence/`). Each Release Candidate stays one until a
second, independent implementation passes its suite (FLR-REQ-092). FS_structural is a Draft whose
suite the engine passes; it becomes a Release Candidate by its own pull request, which freezes it. The conformance oracle in
`tools/oracle/ext/` implements all six, and is evidence for none.

Every official extension follows the same conventions, each stated in its own specification's
chapter 1: its rules apply to a document of a Core draft it lists — all six list Core 0.2, 0.3
and 0.4 — that uses it at a version a validator both implements and knows; its diagnostics are `FS-<CODE>-SCH-`, `-INV-` and `-LINT-`, evaluated after
Core's invariants and never with a Core error; its errors make a document invalid; and what it
derives is `extensions.<NAME>` of the derived values. Records that are not elements — circuits,
stacks, gas sources — share the document's one space of IDs, so diagnostics can name them. Data an
extension records on core elements (FS_structural's, on walls, openings, slabs, rooms and roofs) is
each element's own `extensions.<NAME>`, defined by the schema's `#/$defs/coreElements`, and checked
with the top-level data as the schema tier. Default
clearance envelopes are Floorspec's own round numbers, never a code's; a code's requirements are a
Floorspec Rules pack's to state, with citations.
