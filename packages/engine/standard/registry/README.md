# registry

The Floorspec extension registry (FLR-ADR-007, Core 0.2 chapter 12). Each extension has a
directory named after it, holding the **registry entry** of its current version:

```text
registry/<NAME>/extension.json     the registry entry
registry/<NAME>/spec.md            its specification, tagged in its own ID space ({#FS-ELEC-3.1.1 MUST})
registry/<NAME>/<short>.schema.json   its JSON Schema, whose $id is the entry's `schema` URL
```

The specification and schema are optional for a Proposal and required from Draft on; the suite is
`conformance/ext/<NAME>/<version>/` (`conformance/README.md`). The spec site publishes a schema at
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

| Status | What it means | To get here |
|---|---|---|
| **Proposal** | an idea with a name reserved | an entry and a written rationale |
| **Draft** | specified and changing | a specification, a schema at a versioned URL, and conformance tests |
| **Release Candidate** | specified and frozen unless implementations find a problem | at least one implementation passing the tests |
| **Ratified** | stable | a schema, a conformance suite, and **two independent implementations** listed in `implementations` (the entry schema refuses a ratified entry with fewer) |

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

All four list one implementation, D3 Floorspec's engine. The conformance oracle in
`tools/oracle/ext/` implements them too, but it is written by the same project and is not an
independent implementation: each stays a Release Candidate until a second, independent
implementation passes its suite (FLR-REQ-092).

Every official extension follows the same conventions, each stated in its own specification's
chapter 1: its rules apply to a Core 0.2 document that uses it at a version a validator both
implements and knows; its diagnostics are `FS-<CODE>-SCH-`, `-INV-` and `-LINT-`, evaluated after
Core's invariants and never with a Core error; its errors make a document invalid; and what it
derives is `extensions.<NAME>` of the derived values. Records that are not elements — circuits,
stacks, gas sources — share the document's one space of IDs, so diagnostics can name them. Default
clearance envelopes are Floorspec's own round numbers, never a code's; a code's requirements are a
Floorspec Rules pack's to state, with citations.
