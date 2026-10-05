# 10. Jurisdiction profiles

A **jurisdiction profile** says which codes are in force where a house is built: which edition of
each, from when, and which local amendments change them. A rule names the one edition it was
written for (3.2); the profile decides whether that edition is the one in force. The same packs,
evaluated under two profiles, give two reports — and changing a project's profile is how its
findings follow a change of jurisdiction or a code cycle.

## 10.1 The profile object

| Member | Type | Default | Meaning |
|---|---|---|---|
| `floorspecRules` | `"0.1"` | — (always present) | the draft the profile targets |
| `name` | string, 1–200 characters | — (always present) | the profile's name: `"Model Codes (latest)"` |
| `jurisdiction` | string, 1–200 characters | absent | where it applies: `"Town of Example, MA"` |
| `adopts` | array of adoptions | — (always present) | the editions it adopts (10.2) |
| `asOf` | date | absent | the date the profile is evaluated at (10.2, 10.5) |
| `packs` | array of `{ "name": pack name, "version": version range }` | absent: every usable pack | the packs it selects (10.4) |
| `amendments` | array of amendments (10.5) | `[]` | the local amendments it applies |
| `extras` | object | `{}` | as Core §1.7 |

An **adoption** is `{ "code", "edition", "effective"? }`: a code (3.2), the edition adopted, and
the date it takes effect, absent when it is not stated.

The profile schema is `schema/rules/0.1/profile.schema.json`, published at
`https://d3cloud.io/floorspec/schema/rules/0.1/profile.schema.json`. A profile's **text** is its
`name`, its `jurisdiction`, and each amendment's `note`.

A profile MUST match the profile schema; two of its adoptions MUST NOT have the same `code` and the same `effective` (or both none); two of its `packs` MUST NOT have the same `name`; and its text MUST NOT contain a match of the assurance pattern (2.5). For a request whose profile breaks any of these, an evaluator MUST report `FS-RULES-002`. {#FS-RULES-10.1.1 MUST}

## 10.2 Editions in force

An adoption **applies** when the profile has no `asOf`, when the adoption has no `effective`, or
when its `effective` is not after `asOf`. The edition of a code **in force** is the edition of the
applying adoption of that code whose `effective` is latest, an adoption with no `effective` counting
as earlier than every date; a code with no applying adoption has no edition in force.

So a jurisdiction moving from one edition to the next adopts both, each with the date it took
effect, and a project evaluated `asOf` a date before the change is checked against the older one.

An evaluator MUST decide the edition of each code in force exactly as this section defines it. {#FS-RULES-10.2.1 MUST}

## 10.3 Rules in force

A rule is **in force** under a profile when its citation's `edition` is the edition of its
citation's `code` in force. A rule that is not in force is not evaluated, and is listed in
`notEvaluated` with the reason `"edition"` (9.1): a pack may hold the same requirement for several
editions, as several rules, and the profile picks one.

An evaluator MUST evaluate a rule only when it is in force, and MUST list every other rule of a selected, usable pack that is well typed and uses no deferred measure in `notEvaluated` with the reason `"edition"`. {#FS-RULES-10.3.1 MUST}

## 10.4 Packs

A profile with `packs` **selects** the usable packs it names at a version in their ranges (Core
§12.3 grammar and precedence); a profile without `packs` selects every usable pack of the request.
The rules of a usable pack the profile does not select are listed in `notEvaluated` with the reason
`"profile"`.

An evaluator MUST evaluate only the packs a profile selects, and MUST report `FS-RULES-010` for each entry of the profile's `packs` that no usable pack of the request satisfies — a pack of that name at a version in that range. {#FS-RULES-10.4.1 MUST}

## 10.5 Amendments

A local amendment changes a model code where a jurisdiction adopted it. It is cited by reference,
like a rule — to an ordinance, a statute or a state code — and in this draft it **withdraws** rules:
the amended section is no longer checked by the model rule. A jurisdiction's own requirement, where
it adds one, is a rule in a pack of its own, citing the local code, which the profile adopts like
any other.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `citation` | `{ "authority": string 1–200, "reference": string 1–200, "link"?: https URI }` | — (always present) | who made the amendment, and where: `"Ord. 2025-14 §3"` |
| `effective` | date | absent | when it takes effect |
| `withdraws` | array of `{ "pack": pack name, "rule": rule ID }`, at least one | — (always present) | the rules it withdraws |
| `note` | string, 1–2000 characters | absent | what the amendment changes, in the profile author's words |

An amendment **applies** when the profile has no `asOf`, when the amendment has no `effective`, or
when its `effective` is not after `asOf`. A rule that an applying amendment withdraws is not
evaluated, and is listed in `notEvaluated` with the reason `"withdrawn"`.

An evaluator MUST NOT evaluate a rule that an applying amendment withdraws, and MUST report `FS-RULES-011` for each entry of an applying amendment's `withdraws` that names no rule of a usable pack. {#FS-RULES-10.5.1 MUST}

## 10.6 The default profile

A request without a `profile` is evaluated under the **default profile**, "Model Codes (latest)":
the latest model codes the first rule packs are written for (FLR-ADR-011, FLR-REQ-099).

```json
{
  "adopts": [
    { "code": "IFGC", "edition": "2024" },
    { "code": "IMC", "edition": "2024" },
    { "code": "IPC", "edition": "2024" },
    { "code": "IRC", "edition": "2024" },
    { "code": "NEC", "edition": "2026" }
  ],
  "floorspecRules": "0.1",
  "name": "Model Codes (latest)"
}
```

An evaluator MUST evaluate a request that has no `profile` under exactly this default profile. {#FS-RULES-10.6.1 MUST}

The default profile adopts model codes as published, with no amendment: no jurisdiction adopts
them unchanged, and a project that knows where it will be built uses that jurisdiction's profile.

## 10.7 Changing the profile

Because evaluation is a function of its inputs (1.4), evaluating the same document and packs under
another profile is all it takes to re-evaluate a project for a new jurisdiction, a new code cycle or
a later `asOf`. Nothing about an earlier evaluation carries over.
