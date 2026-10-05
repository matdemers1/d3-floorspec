# @floorspec/cli

The `floorspec` command line, on `@floorspec/engine`.

```sh
floorspec validate house.floorspec.json          # one line per diagnostic, then a summary
floorspec validate house.floorspec.json --json   # the conformance-shaped result: valid, diagnostics, hash, derived
floorspec canonicalize house.floorspec.json      # the canonical form (9.2)
floorspec hash house.floorspec.json              # the content hash (9.3)
floorspec derive house.floorspec.json            # derived walls, junction fills, rooms and openings
floorspec migrate old.floorspec.json --to 0.3    # the document migrated to Core 0.3 (Core chapter 20)

# The .floorspec package (FLR-T-9.1; layout in packages/package/README.md): model.json and its assets
floorspec package house.floorspec.json -o house.floorspec            # assets read beside the document
floorspec package house.floorspec.json --assets ./kitchen -o k.floorspec
floorspec unpack house.floorspec -o ./house                          # the same files, as a folder
floorspec validate house.floorspec                                   # a package, as a package validator
```

`package` writes nothing unless the result is a valid package (each asset's file present, its
digest and length the document's). `unpack` writes into a new or empty folder only, after the
archive's zip-slip, link and size checks; the folder's files are byte-identical to the archive's.

`migrate` prints the migration as Core 20.1.1 writes it — the document declaring the target, its
members sorted, nothing else changed — except what the target draft reads differently, which it
moves into `extras["floorspec:migration"]` and names on standard error: a 0.1 document's opaque
top-level extension `collections`, a 0.2 extension element's own `option`. It takes `--to` and no
other option, because a migration depends on the document and the target alone, and it refuses a
document that cannot be read or a target that is earlier or unknown (`FS-MIG-001`, exit 1). The
library is `@floorspec/migrate`.

Exit status: 0 valid (or migrated), 1 invalid (or refused), 2 usage or I/O error. `-` reads standard input. Its tests run the
built binary against the conformance suite vendored in `packages/engine/standard`.
