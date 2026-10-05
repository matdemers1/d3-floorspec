# 2. Rule packs

A **rule pack** is versioned data: a named set of rule records, published under CC BY 4.0, with a
list of what it covers and what it does not. Packs are separate from documents — a pack is never
embedded in a model — and from the software that evaluates them (FLR-ADR-011).

This chapter defines the pack as an evaluator reads it: one JSON object. How a pack is kept on
disk, its contributor certification and its full provenance and review records are the rule-pack
format's (FLR-T-6.3), which builds on this object and does not change what it means.

## 2.1 The pack object

| Member | Type | Default | Meaning |
|---|---|---|---|
| `floorspecRules` | `"0.2"` | — (always present) | the draft of Floorspec Rules the pack targets |
| `name` | string matching `^[a-z0-9]+(-[a-z0-9]+)*$`, 1–64 characters | — (always present) | the pack's name: `us-model-latest` |
| `version` | `<major>.<minor>.<patch>`, with an optional `-prerelease` (Semantic Versioning 2.0.0, as a registry entry's, Core §12.2) | — (always present) | the version of the pack's data |
| `title` | string, 1–200 characters | — (always present) | a human-readable name |
| `license` | `"CC-BY-4.0"` | — (always present) | the pack's licence (2.3) |
| `description` | string, 1–2000 characters | absent | what the pack is for |
| `rules` | object: rule ID → rule record (chapter 3) | — (always present) | the rules |
| `coverage` | array of coverage entries (2.4) | `[]` | what the pack addresses, and what it does not |
| `extras` | object | `{}` | data no specification defines, as Core §1.7 |

A **rule ID** is the rule's member name in `rules`, and matches the pattern of a Core element ID,
`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. Rule IDs are unique within their pack by construction: a JSON
text whose object has two members of one name is not well formed (Core §9.1.2), and a request
holding one is reported as `FS-RULES-001` (1.1). A rule is named, everywhere outside its pack, by
its pack's name and its ID.

The pack schema is `schema/rules/0.2/pack.schema.json`, published at
`https://d3cloud.io/floorspec/schema/rules/0.2/pack.schema.json`; it refers to the rule record
schema, `rule.schema.json` beside it.

A pack MUST match the pack schema; an evaluator MUST report `FS-RULES-004` for each pack of a request that does not, and MUST NOT evaluate it. {#FS-RULES-2.1.1 MUST}

## 2.2 Names

A pack's name identifies it in a profile (10.4), in an amendment (10.5) and in every finding. Two
versions of one pack are one pack at two versions, and a request carries at most one of them.

The packs of one request MUST have distinct names: an evaluator MUST report `FS-RULES-005` for every pack that matches the pack schema and whose name another such pack of the request shares, and MUST NOT evaluate any of them. {#FS-RULES-2.2.1 MUST}

## 2.3 Licence

Every pack is published under the Creative Commons Attribution 4.0 International licence, and says
so as `"license": "CC-BY-4.0"` — an SPDX identifier, which the pack schema requires. Anyone may
copy, change and redistribute a pack, with attribution. What a pack licenses is its own data: the
citations, the thresholds as individual values, and the contributors' paraphrases. A code's text
is not in a pack to license (0.7).

## 2.4 Coverage

A pack's `coverage` says which sections of which codes it addresses, and which it does not, so
that a reader of a report can tell "no finding" from "not checked" (FLR-REQ-096). A **coverage
entry**:

| Member | Type | Default | Meaning |
|---|---|---|---|
| `code` | code name (3.2) | — (always present) | the code: `IRC` |
| `edition` | edition (3.2) | — (always present) | its edition: `"2024"` |
| `section` | section reference (3.2) | — (always present) | the section or chapter: `R310` |
| `status` | `"addressed"`, `"partial"` or `"notAddressed"` | — (always present) | whether the pack's rules check it in full, in part, or not at all |
| `note` | string, 1–2000 characters | absent | what is and is not checked, in the contributor's words |

The coverage matrix a pack publishes — every section by status, with the date each rule was last
verified — is generated from these entries and the rules' provenance by the pack format's tooling
(FLR-T-6.3). An evaluator carries the entries that apply into its report (9.1).

## 2.5 Wording

A pack is advice, and its text has to read as advice. Its **text** is: its `title` and
`description`; each rule's `title` and `paraphrase`; each exception's `note` (3.7); each coverage
entry's `note`; and each rule's provenance `note` (3.12). The **assurance pattern** is this regular
expression, in the syntax of ECMAScript (ECMA-262), matched with the flag `i` (ignoring case):

```text
\b(non-?)?compl(y|ies|ied|ying|iant|iance)\b|\b(meets?|pass(es|ed)?) (the )?codes?\b|\bup to codes?\b|\bcode[- ]approved\b
```

It matches the words that say a design meets a code — *comply*, *complies*, *compliant*,
*compliance* and their negations — and the phrases *meets code*, *passes the code*, *up to code*
and *code approved*.

The text of a pack MUST NOT contain a match of the assurance pattern; an evaluator MUST report `FS-RULES-006` for each pack that matches the pack schema and does, and MUST NOT evaluate it. {#FS-RULES-2.5.1 MUST NOT}

The same pattern guards a profile's text (10.1) and everything an evaluator writes itself (9.5).
A paraphrase says what a requirement asks for — "every sleeping room has an opening a person can
escape through" — never that a design satisfies it.
