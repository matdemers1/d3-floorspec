# 3. Rule records

A **rule record** is one checkable requirement of one edition of one code: where it comes from,
what it asks in the contributor's own words, what it applies to, the comparison a design is
expected to pass, when it does not apply, how serious a finding is, and who verified it.

## 3.1 Members

| Member | Type | Default | Meaning |
|---|---|---|---|
| `title` | string, 1–200 characters | — (always present) | a short name in the contributor's words: "Escape opening in every sleeping room" |
| `citation` | citation (3.2) | — (always present) | the code, edition and section the rule checks |
| `paraphrase` | string, 1–2000 characters | — (always present) | what the requirement asks, in the contributor's own words (3.3) |
| `applies` | applicability (3.4) | — (always present) | the rule's subjects |
| `select` | selection (3.5) | absent: the requirement is tried on the subject itself | the subject's alternatives the requirement is tried on |
| `requirement` | test (3.8) | — (always present) | what a subject, or its selected alternatives, is expected to pass |
| `exceptions` | array of exceptions (3.7) | `[]` | when a subject is exempt |
| `severity` | `"mayNotMeet"`, `"check"` or `"note"` | — (always present) | how a finding of this rule reads (3.11) |
| `provenance` | provenance (3.12) | — (always present) | who verified the rule, against which edition, and when |
| `extras` | object | `{}` | as Core §1.7 |

The rule record schema is `schema/rules/0.1/rule.schema.json`, published at
`https://d3cloud.io/floorspec/schema/rules/0.1/rule.schema.json`. A rule is part of its pack: a
rule that does not match its schema makes its pack not match the pack schema (2.1).

## 3.2 Citation

| Member | Type | Default | Meaning |
|---|---|---|---|
| `code` | string matching `^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*$`, 1–32 characters | — (always present) | the code, by its short name: `IRC`, `NEC`, `IPC`, `IMC`, `IFGC` |
| `edition` | string matching `^[0-9A-Za-z][0-9A-Za-z.-]{0,15}$` | — (always present) | the edition, usually its year: `"2024"` |
| `section` | string of 1–64 characters, with no control character (U+0000 to U+001F, U+007F to U+009F), that neither begins nor ends with a space | — (always present) | the section as the code numbers it: `R310.2.1`, `110.26(A)(1)` |
| `link` | an absolute `https` URI with an authority, as Core §8.6 | absent | the section in the publisher's free public viewer |

A citation is a reference, never a quotation: it names where a requirement is, and the paraphrase
says what it asks.

A rule's citation SHOULD carry a `link` to the cited section in the publisher's free public viewer, so that a reader can check the requirement at its source. {#FS-RULES-3.2.1 SHOULD}

## 3.3 Paraphrase

The paraphrase is the contributor's own statement of what the cited section requires, written for
someone deciding whether a design needs a second look: what it applies to, what it asks, and how
the rule measures it, including what the rule does not check. It is original prose (0.7), and it
is the text a reader sees beside a finding. Like all of a pack's text, it never says that a design
meets a code (2.5).

## 3.4 Applicability

`applies` names the rule's **subjects**:

| Member | Type | Default | Meaning |
|---|---|---|---|
| `to` | `"room"`, `"opening"`, `"element"` or `"level"` | — (always present) | the kind of subject |
| `extension` | extension name (Core §1.6.1) | absent | for `"element"` only: only the elements of this extension |
| `collection` | collection name (Core §12.5) | absent | for `"element"` only, with `extension`: only the elements of this collection |
| `where` | test (3.8) | absent: every candidate subject | a test each subject passes |

The **candidate subjects** are every room of the document for `"room"`; every opening for
`"opening"`; every extension element for `"element"` (Core §12.5) — of `extension` when it is
given, and of its `collection` when that is given too; and every level for `"level"`. The rule's
**subjects** are the candidate subjects for which `where`, evaluated on the candidate subject,
holds. An extension element is found from its core members alone (Core §12.5), so a rule applies to
the elements of an extension the evaluator does not implement too, as long as it reads none of
their own members (3.10).

An evaluator MUST find the subjects of every evaluated rule exactly as this section defines them. {#FS-RULES-3.4.1 MUST}

## 3.5 Selection

Some requirements are about one of a subject's alternatives: a sleeping room needs *an* opening a
person can escape through, of any of its windows and doors; a panel needs *its* working space
clear. `select` names the subject's **candidates**, and how many of them must pass the requirement:

| Member | Type | Default | Meaning |
|---|---|---|---|
| `from` | candidate set (below) | — (always present) | the subject's candidates |
| `args` | object | `{}` | the candidate set's arguments |
| `where` | test (3.8) | absent: every candidate | a test each candidate passes |
| `need` | `"any"` or `"all"` | — (always present) | whether some candidate, or every candidate, must pass the requirement |

| Subject | `from` | `args` | The candidates |
|---|---|---|---|
| room | `"openings"` | `to`: `"outside"` or `"any"` (default `"any"`) | every opening hosted on a wall that has a half-edge on the boundary of the room's face (Core §6.1) — for `"outside"`, only on a wall that lies between the room's face and its level's unbounded face (Core §11.4) |
| room | `"elements"` | `extension`, and `collection` with it (both optional) | every extension element in the room (4.4) — of that extension and collection when given |
| opening | `"envelopes"` | `purpose` (optional) | the opening's clearance envelopes (Core §13.5) — of that purpose when given |
| element | `"envelopes"` | `purpose` (optional) | the element's clearance envelopes — of that purpose when given |
| level | `"rooms"` | `function` (optional) | every room on the level — of that function when given |
| level | `"elements"` | `extension`, and `collection` with it (both optional) | every extension element whose fallback's `level` is the level — of that extension and collection when given |

The candidates are those for which `where`, evaluated on the candidate, holds. A subject
**passes** the requirement when `need` is `"any"` and some candidate passes it, or `need` is
`"all"` and every candidate passes it — so a subject with no candidate fails a rule that needs any,
and passes one that needs all. Without `select`, a subject passes when the requirement holds for
the subject itself.

An evaluator MUST find each subject's candidates, and decide whether the subject passes, exactly as this section defines. {#FS-RULES-3.5.1 MUST}

## 3.6 Requirement

The `requirement` is a test (3.8). It is evaluated on each candidate, or on the subject when the
rule has no `select`. A subject that is not exempt (3.7) and does not pass gets one finding
(chapter 9): it **may not meet** the rule. A subject that passes gets none — and nothing in the
report says that it meets anything (9.5).

An evaluator MUST report exactly one finding for each subject of an evaluated rule that is not exempt and does not pass, and no other finding. {#FS-RULES-3.6.1 MUST}

## 3.7 Exceptions

An exception says when the rule does not apply to a subject, in the contributor's words and as a
test:

| Member | Type | Default | Meaning |
|---|---|---|---|
| `when` | test (3.8) | — (always present) | evaluated on the subject |
| `note` | string, 1–2000 characters | — (always present) | the exception, paraphrased (2.5) |

A subject for which the `when` of some exception holds is **exempt**: it gets no finding, and the
report counts it (9.1).

An evaluator MUST evaluate every exception's `when` on the subject, and MUST treat a subject as exempt exactly when one of them holds. {#FS-RULES-3.7.1 MUST}

## 3.8 Tests

A **test** is one of:

| Test | Holds when |
|---|---|
| a condition `{ "measure": name, "args"?: object, "op": op, "value": value }` | the measure, computed on the target the test is evaluated on with those arguments, compares to `value` by `op` |
| `{ "all": [test, …] }` | every test of the array holds (at least one) |
| `{ "any": [test, …] }` | some test of the array holds (at least one) |
| `{ "not": test }` | the test does not hold |

A test is evaluated on one **target**: the subject, for `applies.where` and an exception's `when`;
a candidate, for `select.where` and — when the rule selects — the requirement. A measure (chapters
4 to 8) is computed on that target, and its value compared with the condition's `value`:

| `op` | Measure types it applies to | `value` | Holds when the measured value |
|---|---|---|---|
| `<`, `<=`, `>`, `>=` | length, area, count, integer | a JSON integer | compares so with `value` |
| `=`, `!=` | length, area, count, integer, term, boolean | a JSON integer, a string or a boolean, as the type is | is, or is not, equal to `value` |
| `in` | length, count, integer, term | a non-empty array of JSON integers, or of strings, as the type is | is equal to one of them |
| `has` | terms | a string | contains it |

Comparisons are exact. An area (4.2) is compared as the exact multiple of one half it is, so a room
of net area `"12.5"` is less than a threshold of 13 and greater than one of 12. A measure with
no value (4.2) equals nothing: every condition on it fails, except `!=`, which holds.

An evaluator MUST evaluate tests exactly as this section defines them. {#FS-RULES-3.8.1 MUST}

## 3.9 Typing

A rule is **well typed** when each of these holds:

- every condition names a measure that chapters 5 to 8 define for the kind of target it is
  evaluated on — the subject's kind (3.4), or the candidates' (3.5): rooms, openings, extension
  elements, clearance envelopes or levels;
- its `args` are exactly arguments that the measure takes, each of the type its definition gives,
  and include every argument it requires;
- its `op` applies to the measure's type, and its `value` is of the kind the table of 3.8 gives;
- `applies.extension` and `applies.collection` appear only with `"to": "element"`, and
  `collection` only with `extension`;
- `select.from` is a candidate set of the subject's kind, and `select.args` are exactly arguments
  of that set, each of the type 3.5 gives;
- `elementMember` (7.1) is used only on elements of an extension the rule names: on the subject —
  in `applies.where`, in an exception, or in the requirement of a rule that does not select — when
  `applies` has `extension`; on candidates — in `select.where`, or the requirement of a rule that
  selects `"elements"` — when `select.args` has `extension`;
- its provenance's `edition` is its citation's `edition` (3.12).

A measure that 4.8 lists as deferred counts, for this test, as a measure defined for every kind of
target, that takes any arguments and applies to every operator and value.

An evaluator MUST report `FS-RULES-007` for a rule of a usable pack that is not well typed, and MUST NOT evaluate it. {#FS-RULES-3.9.1 MUST}

An evaluator MUST report `FS-RULES-008` for a well-typed rule that uses a deferred measure (4.8), and MUST NOT evaluate it. {#FS-RULES-3.9.2 MUST}

## 3.10 Extension data

Most measures read only what Core derives. Some read an extension's own members — an alarm's
`detects`, a circuit's `breaker`, a receptacle's `features` — and their definitions say so
(4.6). A rule **reads** an extension when one of its measures, or one of their arguments, reads
that extension's own members. Such a rule is meaningful only for a document for which that
extension is evaluated (1.2): a reader that does not implement it cannot tell a smoke alarm from a
heat alarm.

An evaluator MUST report `FS-RULES-009` for a rule that is in force and reads an extension that is not evaluated for the document, and MUST NOT evaluate it. {#FS-RULES-3.10.1 MUST}

## 3.11 Severity

A finding's severity says how strongly the rule advises; none of them is an error, and none blocks
anything.

| `severity` | Use it for | The finding's message (9.5) |
|---|---|---|
| `"mayNotMeet"` | a requirement the rule measures directly | says the subject may not meet the citation |
| `"check"` | a requirement the rule can only approximate — it measures a rough opening where the code asks for a net clear one — or one a professional needs to confirm | says so, and asks for a check by a professional or the authority having jurisdiction |
| `"note"` | information worth knowing, such as a common local amendment | says so, and that it is for information |

## 3.12 Provenance

Every rule says who verified it against its source:

| Member | Type | Default | Meaning |
|---|---|---|---|
| `verifiedBy` | string, 1–200 characters | — (always present) | who checked the rule against the cited section |
| `verifiedOn` | date | — (always present) | when |
| `edition` | edition (3.2) | — (always present) | the edition they checked it against: the citation's |
| `reviewed` | `{ "by": string 1–200, "on": date, "credential"?: string 1–200 }` | absent | a licensed professional's review of the rule — the reviewed badge (FLR-REQ-104) |
| `note` | string, 1–2000 characters | absent | anything the verifier wants a reader to know (2.5) |

These are the minimum an evaluator carries; the rule-pack format (FLR-T-6.3) defines what it adds
— a review's scope, a contributor's certification — and how a pack's coverage matrix shows the
dates. A rule whose provenance names another edition than its citation was verified against
something other than what it cites, and is not well typed (3.9).
