# 9. Findings and the report

## 9.1 The report

An evaluation returns one **report**:

| Member | Type | Present | Meaning |
|---|---|---|---|
| `floorspecRules` | `"0.1"` | always | the draft the report follows |
| `notice` | string | always | the notice of 9.9 |
| `units` | `"imperial"` or `"metric"` | when step 1 of 1.3 passed | how values are displayed (9.6) |
| `profile` | string | when step 2 passed | the profile's `name` |
| `hash` | string | when step 3 passed | the document's content hash (Core §9.3) |
| `diagnostics` | array of diagnostics (chapter 11) | always | what is wrong with the request, its profile or its packs |
| `evaluated` | array | always | every rule that was evaluated |
| `notEvaluated` | array | always | every rule of a usable pack that was not, and why |
| `coverage` | array | always | the coverage entries that apply |
| `findings` | array of findings (9.2) | always | the findings |

Each entry of `evaluated` is `{ "pack", "version", "rule", "citation", "subjects", "exempt",
"findings" }`: the pack's name and version, the rule's ID and citation, and how many subjects the
rule had (3.4), how many of them were exempt (3.7) and how many findings it gave (3.6).

Each entry of `notEvaluated` is `{ "pack", "version", "rule", "reason" }`, where `reason` is
`"profile"` when the profile does not select the rule's pack (10.4), `"invalid"` for `FS-RULES-007`,
`"deferred"` for `FS-RULES-008`, `"edition"` when the rule's edition is not in force (10.3),
`"withdrawn"` when an amendment withdraws it (10.5), and `"extension"` for `FS-RULES-009`. A rule
of a pack that is not usable (1.3) is in neither list: its pack could not be read.

`coverage` holds the coverage entries (2.4) of every usable pack the profile selects whose `code`
and `edition` are in force (10.2), each with the member `pack`, its pack's name, added.

An evaluator MUST return a report with exactly the members of this section, and MUST list every rule of every usable pack in exactly one of `evaluated` and `notEvaluated`, with the counts and the reason this section gives. {#FS-RULES-9.1.1 MUST}

An evaluator MUST list in `coverage` exactly the coverage entries this section gives. {#FS-RULES-9.1.2 MUST}

A report says what was checked and what was found. It never lists what "passed": a rule with no
finding is an entry of `evaluated` whose `findings` is 0, and a subject with no finding is not
named at all.

## 9.2 Findings

A **finding** says that one subject may not meet one rule:

| Member | Type | Meaning |
|---|---|---|
| `pack` | string | the pack's name |
| `version` | string | the pack's version |
| `rule` | string | the rule's ID |
| `title` | string | the rule's `title` |
| `citation` | citation | the rule's citation, as the pack gives it: code, edition, section and link |
| `severity` | `"mayNotMeet"`, `"check"` or `"note"` | the rule's severity (3.11) |
| `subject` | target (4.1) | the subject |
| `candidates` | array of targets | present when the rule selects (3.5): the subject's candidates, in order (4.1) |
| `measures` | array of measured conditions (9.3) | what was measured |
| `elements` | array of IDs, sorted | what the finding is about (9.4) |
| `location` | `{ "level": ID, "shapes": [shape, …] }` | where to draw it (9.4) |
| `message` | string | the finding in words (9.5) |

An evaluator MUST give every finding exactly the members of this section. {#FS-RULES-9.2.1 MUST}

## 9.3 Measured conditions

`measures` lists, for each target the requirement was evaluated on — the subject, or each
candidate in order — each condition of the requirement in the order it is written (depth first,
left to right through `all`, `any` and `not`), every one of them, whether or not it decided the
outcome:

| Member | Type | Meaning |
|---|---|---|
| `target` | target (4.1) | what was measured |
| `measure` | string | the measure's name |
| `args` | object | the condition's `args`, when it has them |
| `type`, `value`, `display`, `involved` | | the measure result (4.7) |
| `op` | string | the condition's `op` |
| `threshold` | | the condition's `value` |
| `thresholdDisplay` | string | the threshold as a person reads it (9.6) |
| `holds` | boolean | whether the condition holds (3.8) |

A finding for a subject with no candidate, of a rule that needs any, has no measured condition: the
finding's message and its empty `candidates` say what is missing.

An evaluator MUST list the measured conditions of a finding exactly as this section defines them. {#FS-RULES-9.3.1 MUST}

## 9.4 Elements and location

A finding's `elements` are the subject's ID, each candidate's ID (an envelope's owner's), and every
ID in the `involved` of its measured conditions, each once, sorted.

Its `location` is where a plan draws it: `level` is the subject's level (4.1), and `shapes` lists,
in this order and each once, the **shape** of the subject, of each candidate in order, and of each
ID of `involved` that has a shape, in ID order:

| Of | Shape |
|---|---|
| a room | `{ "kind": "polygon", "outer": ring, "holes": [ring, …] }`: its room polygon (Core §6.2) |
| an opening | `{ "kind": "segment", "points": [start, end] }`: its derived start and end points (Core §7.4) |
| an extension element | `{ "kind": "polygon", "outer": ring, "holes": [] }`: its fallback's footprint (Core §12.6) |
| a clearance envelope | `{ "kind": "polygon", "outer": ring, "holes": [] }`: its footprint (Core §13.5) |
| a wall | `{ "kind": "polygon", "outer": ring, "holes": [] }`: its outline (Core §5.7), starting at its least vertex |
| a level, a circuit | none |

Every ring is as Core derives it: integer points, least vertex first, counter-clockwise for an outer
ring and clockwise for a hole. So a finding about a panel's working space draws the panel, the
space and whatever obstructs it, and one about a bedroom draws the room.

An evaluator MUST give every finding the elements and the location this section defines. {#FS-RULES-9.4.1 MUST}

## 9.5 Wording

A finding's `message` is written from a template, so that every finding of every evaluator reads
the same and none says more than the rule can:

| `severity` | `message` |
|---|---|
| `"mayNotMeet"` | `<subject> may not meet <code> <edition> <section> (<title>).` |
| `"check"` | `<subject> may not meet <code> <edition> <section> (<title>). Check it with a professional or the authority having jurisdiction.` |
| `"note"` | `<subject> may not meet <code> <edition> <section> (<title>). This is for information.` |

`<subject>` is the subject's ID; `<code>`, `<edition>` and `<section>` are the rule's citation's;
and `<title>` is the rule's title. So a message names the edition it was checked against, every
time: `R2 may not meet IRC 2024 R310.1 (Escape opening in every sleeping room).`

An evaluator MUST write every finding's message exactly as this table gives it. {#FS-RULES-9.5.1 MUST}

A report MUST NOT contain a match of the assurance pattern (2.5) anywhere outside the IDs it copies from the document: no finding, message, display or entry says that a design complies with, meets or passes a code. {#FS-RULES-9.5.2 MUST NOT}

## 9.6 Display

A measure result's `display`, and a measured condition's `thresholdDisplay`, give a value as a
person reads it, in the request's `units`. Each is rounded once, with `round()`, from the exact
value:

| Type | `"imperial"` | `"metric"` |
|---|---|---|
| length `v` | `n = round(v / 2032)` sixteenths of an inch, written `F' I"`, or `F' I a/b"` with the fraction `a/b` of an inch in lowest terms, where `F` is the whole feet of `|n|` and `I` the whole inches left: `-` before it when `n < 0` | `round(v / 1280)` millimetres, written `1732 mm` |
| area `A` | `n = round(100 · A / 152212340736)` hundredths of a square foot, written `5.70 sq ft` | `n = round(100 · A / 1638400000000)` hundredths of a square metre, written `0.53 m²` |
| count, integer | the integer in decimal, followed by a space and its unit when it has one: `20 A` | the same |
| boolean | `yes` or `no` | the same |
| term | the term | the same |
| terms | the terms in order, separated by `, `, or `none` when there are none | the same |
| no value | `not stated` | the same |

So 390,144 base units display as `1' 0"`, 1,148,080 as `2' 11 5/16"`, and 152,212,340,736 square base
units as `1.00 sq ft`. A threshold displays as a value of the measure's type; a threshold of `in`
displays each of its values, separated by `, `. An area threshold, an integer of square base
units, displays as an area.

An evaluator MUST write every `display` and `thresholdDisplay` exactly as this section defines them. {#FS-RULES-9.6.1 MUST}

## 9.7 Order

Every array of a report is in a defined order, so that a report is one value:

- `diagnostics` by `code`, then `packIndex`, `pack` and `rule`, a member that is absent sorting
  first;
- `evaluated` and `notEvaluated` by `pack`, then `rule`;
- `coverage` by `pack`, `code`, `edition`, `section`, `status`, then `note`, an absent note first;
- `findings` by `pack`, then `rule`, then the subject (4.1);
- every array of IDs, and `candidates`, as 4.1 orders targets; `measures` as 9.3 and `shapes` as
  9.4 list them.

Strings are compared as sequences of UTF-16 code units, as Core §9.2 compares member names.

An evaluator MUST order every array of a report as this section defines. {#FS-RULES-9.7.1 MUST}

## 9.8 Serialization

A report is written as Floorspec Core writes a canonical document (Core §9.2, step 2): object
members sorted, two spaces of indentation per level, one line feed at the end. Two conformant
evaluators given the same inputs produce the same bytes.

An evaluator MUST write a report exactly as Core §9.2, step 2, writes a value. {#FS-RULES-9.8.1 MUST}

## 9.9 The notice

Every report carries this **notice**, exactly:

> Floorspec findings are advisory. They are not a plan review, and the authority having jurisdiction decides.

An evaluator MUST give the notice, exactly as this section gives it, as the report's `notice`, in every report it returns. {#FS-RULES-9.9.1 MUST}

Software that shows findings to a person SHOULD show the notice wherever it shows a finding, with the coverage of the packs evaluated, and SHOULD NOT shorten or reword a finding's message. {#FS-RULES-9.9.2 SHOULD}
