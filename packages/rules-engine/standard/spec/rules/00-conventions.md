# 0. Conventions

> [!warning] Floorspec Rules 0.2 — Draft
> This is a working draft. It carries no compatibility promise: a later 0.x draft may change any
> part of it. Floorspec Rules is versioned independently of Core and Ops (FLR-ADR-008), and stays
> 0.x until the 1.0 criteria are met (FLR-ADR-017).

Floorspec Core says what a building *is*, and Floorspec Ops how it changes. Floorspec Rules says
how a building is **checked against a code** — and how carefully that check is worded. It defines:

- **rule records**: one requirement of a code, cited by code, edition and section, paraphrased in
  the contributor's own words, and expressed as a typed comparison over named measures with
  integer thresholds (chapters 2 and 3);
- the **named-measure library**: every quantity a rule may compare — a room's net area, an
  opening's sill height, the depth that stays clear in front of a panel, the longest stretch of
  wall with no receptacle — each an exact function of a Core document (chapters 4 to 8);
- **findings**: what an evaluator reports when a design may not meet a rule, worded as advice,
  naming the edition, and placed on the plan (chapter 9);
- **jurisdiction profiles**: which editions of which codes are in force, from when, and which
  local amendments change them (chapter 10).

Every rule is advisory (FLR-ADR-011). A finding says that a design **may not meet** a cited
requirement; nothing in Floorspec Rules ever says that a design meets a code. Rules never make a
document invalid and never stop an edit.

## 0.1 Normative language

The key words `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT` and `MAY` are used as in Floorspec Core
§0.1, and every normative statement ends with a tag `{#FS-RULES-<chapter>.<section>.<n> LEVEL}`.
An identifier is never reused, including after the statement it named is retired. Every `MUST`
and `MUST NOT` is exercised by the conformance suite in `conformance/rules/0.2/`, and the build
that publishes this specification fails if one is not.

## 0.2 Conformance classes

| Class | What it is | What it must do |
|---|---|---|
| **Rule pack** | a JSON object claiming to be a Floorspec Rules pack | match the pack schema and the rules of chapters 2 and 3 |
| **Profile** | a JSON object claiming to be a jurisdiction profile | match the profile schema and the rules of chapter 10 |
| **Evaluator** | software that evaluates rule packs against a Core document under a profile | produce exactly the report of chapter 9, by the rules of chapters 1 and 3 to 11 |

An evaluator is tested by giving it a document, the known extensions its validator is configured
with, and an **evaluation request** (1.1), and comparing the report it returns with the expected
report, byte for byte; and by giving it a document and a list of **measure calls** and comparing
the measure results (4.7). The reference implementation, D3 Floorspec's rules engine, claims the
evaluator class.

Software that shows findings to a person — an editor's findings panel, a printed report, an
agent's answer — is not a conformance class of this draft: what it can be tested on is the report
it shows, which is the evaluator's. Section 9.9 says what it is expected to do with it.

## 0.3 Notation

Floorspec Rules uses Floorspec Core's notation (Core §0.3): lengths are JSON integers of base units
(1/1280 mm, Core §2.1), areas are in square base units, angles in microdegrees, `round()` rounds to
the nearest integer with ties to even, and an exact value is the mathematically exact real number,
rounded only where a definition says so. A **date** is a string `YYYY-MM-DD` (a Gregorian calendar
date); dates are compared as strings, which orders them in time.

Terms from Floorspec Core keep their meanings: element, room, face, unbounded face, room polygon,
opening, extension element, fallback, frame, clearance envelope, owner, content hash, diagnostic,
valid. Terms from Floorspec Ops are not needed: Rules reads documents, and never edits one.

## 0.4 Relation to Floorspec Core and Ops

Floorspec Rules 0.2 evaluates documents that a **Core 0.4 reader** reads — Core 0.4 documents, and
Core 0.3, 0.2 and 0.1 documents read as Core 0.4 reads them (Core §1.2.8) — with the official extensions
(`registry/`) that the evaluator implements. Every measure is defined in terms of what Core and
those extensions derive, so two evaluators that agree on Core agree on every measure.

Rules is a separate stream from validation. A **diagnostic** (Core §10.2) says what is wrong with
a document as a document; a **finding** says that a valid document may not meet a code. Findings
are evaluated on a valid document — in an editor, on the document a batch has just committed
(Ops §1.3) — and never change whether it is valid, what it derives or whether an edit commits.
Floorspec Ops never consults a rule: no step of an Ops transaction evaluates one (FLR-REQ-098).

## 0.5 The shape of a rule

A rule record has the four parts of the **RASE** methodology — Requirement, Applicability,
Selection and Exception — which Floorspec takes by name as the shape of a checkable clause:

| Part | In a rule record | What it says |
|---|---|---|
| Applicability | `applies` | what the rule is about: every sleeping room, every panel |
| Selection | `select` | which of a subject's alternatives the requirement is tried on, and whether any or all must meet it: the windows of a room, the working spaces of a panel |
| Requirement | `requirement` | the comparison a subject, or its selected alternative, is expected to pass |
| Exception | `exceptions` | when the rule does not apply to a subject after all |

Floorspec does not adopt any rule language beyond this shape: a requirement is a small typed test
over named measures (3.8), so that a pack is data a reviewer can read, never code to run.

## 0.6 What this draft does not yet define

- **Measures that need data Core does not yet have**, named in 4.8 and reserved: countertops,
  travel distances, a room's narrowest dimension and a difference of floor elevations. A rule that
  uses one is not evaluated (11.1, `FS-RULES-008`). Ceiling heights were reserved until Core 0.3
  derived ceilings (Core §15), and are `ceilingHeight` (5.7); stairs were reserved until Core 0.3
  defined them (Core §17), and are the measures of 8.5, on a new kind of target, the stair — with,
  from 0.2, the goings of tapered treads that Core 0.4 derives (Core §17.7).
- **The pack format in full**: how a pack is laid out on disk, its per-rule provenance and review
  records, contributor certification and the coverage matrix a pack publishes are the rule-pack
  format's (FLR-T-6.3). This draft defines only what an evaluator reads: the pack object of chapter
  2, with the minimum provenance of 3.12.
- **A needs-a-professional report**, the presentation of findings, and the profile builder: these
  are the reference implementation's, built on the report of chapter 9.

## 0.7 Code text

A rule pack carries facts about a code — that a section exists, what it is about, the numbers it
uses as individual thresholds — and the contributor's own paraphrase, never the code's words. A
pack never quotes a code's text, never reproduces a code's table, and is never built by scraping a
publisher's viewer (FLR-REQ-095). Those are obligations of the people who write packs, set out in
the pack format's contributor rules (FLR-T-6.3); no test can check them, so this specification
states them here rather than as tagged statements.

## 0.8 Changes

**From 0.1 to 0.2.** Floorspec Rules 0.2 is a new draft, not an edit of 0.1. The text of Rules 0.1
stays published, unchanged, at its own URLs, built from the commit that pinned it (`8a99d02` in the
standard's repository); its schemas are at `/floorspec/schema/rules/0.1/` and its suite at
`conformance/rules/0.1/`, and none of them changes. This draft's schemas are at
`/floorspec/schema/rules/0.2/` — 0.1's, every object declaring `"floorspecRules": "0.2"` — and its
suite at `conformance/rules/0.2/`, which holds every 0.1 test carried forward as well as the new ones.

What 0.2 adds:

- **Core 0.4 documents**: an evaluator reads a document as a Core 0.4 reader (1.2), which derives the
  steps, walkline, goings and headroom of winder and spiral stairs (Core §17.7) — so `stairHeadroom`
  has a value for a winder or a spiral stair with something above it, where under 0.1 it had none
  (8.5);
- three stair measures (8.5): `stairForm`, the kind of a stair's form, so that a rule can apply to
  winder or spiral stairs alone; `stairWalklineGoing`, the least going of its tapered treads at the
  walkline; and `stairNarrowGoing`, the least going of its tapered treads at their narrow ends — the
  quantities a code's rules for winders and spiral stairs compare with thresholds;
- requests, packs, profiles and reports that declare `"0.2"`: an evaluator of 0.2 reads a request, a
  pack or a profile of 0.1 as it reads one of any other draft — not at all (`FS-RULES-001`,
  `FS-RULES-004`, `FS-RULES-002`) — since what 0.1's `stairHeadroom` measured is not what 0.2's does.

Statements whose meaning changed were given new IDs, and their old IDs are retired, never reused:

| Retired | Replaced by | Why |
|---|---|---|
| `FS-RULES-1.2.1` | `FS-RULES-1.2.3` | a document is read, and is valid or not, as a Core 0.4 validator reads it |
| `FS-RULES-8.5.1` | `FS-RULES-8.5.2` | the stair measures are those of 0.2, `stairHeadroom` among them with a value for a tapered stair |

Every other statement of 0.1 keeps its ID and its meaning; where a schema or a table it refers to has
grown or now names `"0.2"`, the statement applies to the new draft's.

## 0.9 Related

FLR-ADR-011 (rules advise; packs are cited data under CC BY 4.0; findings never say "compliant"),
FLR-REQ-093 (rule records, measures, findings, profiles), FLR-REQ-097 (advisory wording that names
the edition), FLR-REQ-098 (never block an edit), FLR-REQ-099 (the default profile), FLR-R-007 (the
risk that a pack is wrong or reads as legal advice).
