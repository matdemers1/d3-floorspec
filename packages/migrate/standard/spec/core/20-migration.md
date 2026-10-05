# 20. Migration

A document targets one draft (1.2). Reading an earlier draft's document is a reader's job, and 1.2.6
says how a reader of this draft does it. **Migrating** a document is different: it rewrites the
document so that it targets a later draft, and means exactly what it meant. This chapter defines
the migration from every earlier draft to this one, once, as a function of the document and the
target, so that every migrator writes the same bytes and nothing is lost on the way.

## 20.1 Migrations and migrators

A **migrator** is software that migrates documents: given a document that declares a draft N and a
**target** draft M, it writes the **migration** of the document to M. A migration is made of
**steps**, each from one draft to the next: from 0.1 to 0.2 (20.4) and from 0.2 to 0.3 (20.5). A
step makes the document declare the next draft and rewrites, by the rules this chapter states for
it, the members whose meaning that draft changes; it changes nothing else. A member that a later
draft no longer has, or that no rewrite can carry with its meaning, is **moved** out of the way
(20.3), never dropped.

A migrator MUST write the migration of a document to a draft — the document this chapter defines — exactly as step 2 of 9.2 writes a value: its members sorted, two spaces of indentation, a final line feed. {#FS-CORE-20.1.1 MUST}
A migration omits no default: step 1 of 9.2 is the canonical form's, and a migration changes only
what its steps change. So the migration of a document in canonical form — as every document a tool
stores is — is in canonical form itself, and the migration of any other document has the canonical
form of the migration of its canonical form whenever the document is valid.

The migration of a document to the draft it declares MUST be the document itself. {#FS-CORE-20.1.2 MUST}

The migration of a document from a draft N to a later draft M MUST be the result of applying every step from N to M in order: from 0.1 to 0.3, the step from 0.2 to 0.3 applied to the result of the step from 0.1 to 0.2. {#FS-CORE-20.1.3 MUST}

A migration MUST NOT change anything in a document but what its steps change: the version declaration, the members they move, and the record of what they moved (20.3). {#FS-CORE-20.1.4 MUST NOT}

A migration is therefore a deterministic function of the document and the target alone. It does not
depend on the extensions a migrator implements, on the known extensions it is configured with
(12.2), on the files of a package, on a clock or on a network; and every other member of the
document, the content of extension data and of `extras` included, comes through unchanged, as
1.6.6 and 1.7.2 require of every writer. Its content hash (9.3) is its own: a migrated document
declares another draft, so its canonical form and its hash differ from the original's (except when
the target is the draft it declares).

A migrator of this draft migrates documents of 0.1, 0.2 and 0.3 to any of those drafts that is not
earlier than the one they declare.

## 20.2 What a migrator is given

A migration is defined by the structure of a document, which the schema of its draft guarantees,
and not by whether its geometry holds. A document that breaks an invariant — a dangling reference,
crossing walls — is migrated like any other, and its migration breaks the same invariants (20.6).

A migrator MUST refuse a document that is not a well-formed JSON text as 9.1 requires, that does not declare a draft the migrator implements, or that does not match the schema of the draft it declares, and report for it exactly the diagnostics that a validator implementing every extension reports for it at tiers 1 to 3 (10.1): `FS-JSON-001` to `FS-JSON-003`, `FS-DOC-001` or `FS-SCH-001`. {#FS-CORE-20.2.1 MUST}

A migrator MUST migrate every other document, including one whose `extensionsRequired` names an extension the migrator does not implement and one that breaks an invariant. {#FS-CORE-20.2.2 MUST}
A migrator moves extension data only as the steps say and reads none of it, so it needs to implement
no extension: a reader that does not implement a required extension rejects the document with
`FS-DOC-002` (1.6.4), and a migrator never reports it. Nor does it have known extensions (12.2), so
it never reports `FS-CFG-001`.

A migrator MUST refuse a target that is not a draft it implements, or that is earlier than the draft the document declares, with the diagnostic `FS-MIG-001`. {#FS-CORE-20.2.3 MUST}
A migration never goes backwards: an earlier draft cannot say everything a later one can. The
target is checked after the document, so a document refused by 20.2.1 is refused with its own
diagnostics alone.

## 20.3 Moved members and their record

A step **moves** a member by removing it from where it is and recording it in the document's
`extras` (1.7), under the member `floorspec:migration`: an array of **records**, one for each step
that moved something, in the order the steps were applied. A record is an object:

| Member | Type | Meaning |
|---|---|---|
| `from` | version string | the draft the step migrated from |
| `to` | version string | the draft the step migrated to |
| `moved` | array of `{ "pointer": JSON Pointer, "value": any JSON }` | every member the step moved: `pointer`, where it was in the document the step was given (RFC 6901), and `value`, its value, unchanged |

```json
"extras": {
  "floorspec:migration": [
    { "from": "0.1", "to": "0.2",
      "moved": [ { "pointer": "/extensions/FS_furniture/collections", "value": { "pieces": { … } } } ] }
  ]
}
```

A step that moves members MUST remove each of them from the document and append one record to the array `floorspec:migration` of the document's `extras` — creating the array, and `extras`, when the document has none — whose `moved` lists them sorted by `pointer`, comparing pointers as sequences of UTF-16 code units. {#FS-CORE-20.3.1 MUST}

A step that moves nothing MUST NOT add a record, nor change `extras`. {#FS-CORE-20.3.2 MUST NOT}

A migrator MUST refuse a document whose `extras` has a member `floorspec:migration` that is not an array when a step of the migration moves something, with the diagnostic `FS-MIG-002`. {#FS-CORE-20.3.3 MUST}

So a document migrated twice keeps both records, in order, and a record says exactly what to put
back to recover the document the step was given. A record is `extras`: nothing is derived from it
(1.7.1), a writer preserves it (1.7.2), and it carries no meaning a reader acts on. Its member name
is the one name in a document's `extras` that this specification defines; an application never
needs it for anything else.

## 20.4 From 0.1 to 0.2

Core 0.2 added members to 0.1 (0.7) and took none away, and a 0.1 document has none of the members
0.2 added, because the 0.1 schema rejects every one of them (1.2.6). One member changed its meaning:
in 0.1 an extension's top-level data is opaque, all of it; in 0.2 its member `collections` holds the
extension's elements (12.5), from which core derives fallbacks, placements and clearances, and whose
shape core checks. Data that 0.1 called opaque cannot keep its meaning under that name, so the step
moves it.

The step from 0.1 to 0.2 MUST make the document declare `"0.2"`, and move the member `collections` of every extension's top-level data that is an object with that member, and change nothing else. {#FS-CORE-20.4.1 MUST}

The pointer of each is `/extensions/<name>/collections`. The extension's data stays in `extensions`,
without that member — `{}` when it had no other — and the extension stays declared in
`extensionsUsed`.

## 20.5 From 0.2 to 0.3

Core 0.3 added members to 0.2 (0.6) and took none away, and the 0.2 schema rejects every one it added
to the elements, objects and collections core defines. One member it added sits where 0.2 left the
names to the extension: an extension element's own members are the extension's, except those
core defines (12.5), and 0.3 defines one more, `option`, the option the element is in (19.2). In a
0.2 document an extension element's `option` is the extension's data, and a 0.3 reader reads it as
absent (1.2.6), so the step moves it.

The step from 0.2 to 0.3 MUST make the document declare `"0.3"`, and move the member `option` of every extension element (12.5) that has one, and change nothing else. {#FS-CORE-20.5.1 MUST}

The pointer of each is `/extensions/<name>/collections/<collection>/<ID>/option`.

## 20.6 What a migration preserves

A step changes nothing a reader of the later draft derives anything from. The members it moves are
ones a reader of that draft does not read in the document the step is given — opaque extension
data, an extension element's own member (1.2.6) — and does not read in `extras` either; and with
the version declared, everything else is read as it was. So a reader of the target reads the
migration of a document exactly as it reads the document.

A reader of the target draft that implements no extension and is configured with no known extensions MUST report for the migration of a document the validity and the diagnostics it reports for the document, and derive from it exactly the values it derives from the document. {#FS-CORE-20.6.1 MUST}

By 1.2.6 those are, for a document valid under its own draft, the values a reader of its own draft
derives for it — and the values that draft did not derive yet, from the defaults. Every one is
preserved, for the primary design (a document of 0.1 or 0.2 has no other):

| Derived | Preserved from |
|---|---|
| `walls`, `junctionFills`, `rooms`, `unanchored`, `openings` | 0.1 |
| `program`, `fallbacks`, `placements`, `clearances`, `clearanceOverlaps`, `circulation` | 0.2 (and from 0.1, as a reader of 0.2 derives them for a 0.1 document: circulation from its rooms and doors, nothing for the rest) |
| `floors`, `ceilings`, `slabs`, `roofs`, `stairs`, `finishes` | 0.3 (and from 0.1 and 0.2, as a reader of 0.3 derives them: from the defaults, with no roof and no stair) |

The validity, the diagnostics and the derived values are preserved; the content hash and the
canonical form are not, because the document declares another draft (20.1).

## 20.7 Previous versions and later majors

Floorspec follows Semantic Versioning (1.2). Each major version of the specification ships a
normative migration from the major before it — a chapter like this one, with its conformance tests —
and a reference migrator; and a reader of a major reads documents of the major before it, either as
1.2.6 reads them or by migrating them on load. While the major version is 0 every draft is a major in
this sense: the version before a draft is the draft before it, so the migrations of this chapter are
from 0.1 and 0.2, and a reader of this draft reads documents of 0.2, and of 0.1 too (1.2.6). Floorspec
1.0 will read documents of the last 0.x draft and ship the migration from it.

The reference migrators of this draft are the conformance oracle's (`tools/oracle/migrate.py` in the
standard's repository), from which the suite's expected outputs are made, and D3 Floorspec's
(`@floorspec/migrate`), which passes the suite.

## 20.8 Diagnostics

A migrator reports what refuses a document or a target as a diagnostic (10.2) with these codes, and
the codes of 10.4 for a document 20.2.1 refuses. Each is an error and involves no element.

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-MIG-001` | error | the target is not a draft the migrator implements, or is earlier than the draft the document declares | — | 20.2.3 |
| `FS-MIG-002` | error | a step of the migration moves members, and the document's `extras` has a member `floorspec:migration` that is not an array | — | 20.3.3 |

## 20.9 The conformance suite

The migration suite is `conformance/migration/0.3/`, one directory per test:

```text
conformance/migration/0.3/<group>/<NNN-slug>/
  test.json        what the test is and which statements it covers
  input.json       the document, byte for byte
  request.json     the target: { "to": "0.3" }
  expected.json    { "status": "migrated" | "refused", "diagnostics": [ … ],
                     "hash": the migration's content hash, and
                     "validation": { "valid", "diagnostics" }, what a reader of the target reports for
                     the document and for its migration alike (20.6) - both only when it is migrated }
  output.json      the migration, written as 20.1.1 says - present exactly when it is migrated
```

A migrator conforms on a test when it migrates or refuses as `status` says, reports `diagnostics`
(compared as a validator's are, on `code`, `severity` and `elements`), and writes exactly the bytes
of output.json.

## 20.10 Related

FLR-REQ-150 (every major version ships a normative migration and a reference migrator), FLR-REQ-172
(a conformant reader reads files of the previous major version), FLR-ADR-017 (Floorspec stays 0.x
until the 1.0 criteria are met). Section 1.2 (the version declaration, and reading 0.1 and 0.2
documents), 1.7 (extras), 9.2 and 9.3 (the canonical form and the content hash), 12.5 (extension
elements) and 19.2 (membership of options). Floorspec Ops expresses a migration as a batch: `unsetProperty`
of `$document` for every member it moves, `setProperty` of `$document` `/extras/floorspec:migration`
and of `/floorspec` (Ops 2.3).
