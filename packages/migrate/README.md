# @floorspec/migrate

The reference migrator of Floorspec Core 0.3, chapter 20 (FLR-T-12.4, FLR-REQ-150): a document of
Core 0.1 or 0.2 migrated to a later draft, byte for byte as the migration suite says, and the
Floorspec Ops batch that makes the same change to a stored plan. Isomorphic (FLR-ADR-010) and
deterministic: a migration depends on the document and the target alone (Core 20.1).

```ts
import { migrate, migrationBatch, needsMigration } from '@floorspec/migrate';

const r = migrate(bytes, '0.3');          // or a string, or a parsed document; the target defaults to 0.3
if (r.status === 'migrated') {
  r.text;     // the migration, written as Core 20.1.1 says: members sorted, no default omitted
  r.hash;     // its content hash (Core 9.3)
  r.records;  // what each step moved into extras["floorspec:migration"]
} else {
  r.diagnostics; // FS-JSON-, FS-DOC-001, FS-SCH-001 (Core 20.2.1), FS-MIG-001 (target), FS-MIG-002 (record)
}

needsMigration(document);   // does it declare a draft before 0.3?
migrationBatch(document);   // the Ops batch: unsetProperty of every moved member, the record, the version
```

## What a migration does

Each step makes the document declare the next draft and changes nothing else — except the members
the next draft reads differently, which it **moves** into `extras["floorspec:migration"]` with a
record of where they were (Core 20.3), so that a reader of the target reads the migration exactly as
it reads the document (Core 20.6):

| Step | Moved | Why |
|---|---|---|
| 0.1 → 0.2 | `collections` of an extension's top-level data | opaque in 0.1; extension elements in 0.2 (Core 12.5) |
| 0.2 → 0.3 | `option` of an extension element | the extension's own member in 0.2; core's option membership in 0.3 (Core 19.2) |

For almost every plan that is the version alone. A plan where it is not used to be "upgraded" by
`setProperty $document /floorspec "0.3"`, which either changed what it meant (opaque data became
extension elements) or was rejected (data that is malformed as 0.3 reads it). The editor's upgrade
offers, the roof, stair, furniture and systems tools, and the electrical assistant now send
`migrationBatch` instead, which is that one op whenever nothing moves.

## Tests

- `test/conformance.node.test.ts` — the migration suite, vendored from floorspec at the commit in
  `standard/LOCK.json` (`pnpm --filter @floorspec/migrate sync-standard [<floorspec checkout>]`):
  status, diagnostics, the bytes of output.json, the hash, and the engine reading the document and
  its migration alike.
- `test/property.node.test.ts` — every Core 0.1 and 0.2 conformance document (the engine's vendored
  suites) that its draft's schema accepts migrates to 0.3; the engine reads it and its migration
  alike, and a valid one's migration keeps every value its own draft's suite says it derives; and
  `migrationBatch` applied by `@floorspec/ops` commits exactly the migration's canonical form.
- `test/migrate.test.ts` — the steps, the refusals, and the batch and its inverse.

The CLI is `floorspec migrate <file> --to 0.3` (`@floorspec/cli`).
