# @floorspec/cli

The `floorspec` command line, on `@floorspec/engine`.

```sh
floorspec validate house.floorspec.json          # one line per diagnostic, then a summary
floorspec validate house.floorspec.json --json   # the conformance-shaped result: valid, diagnostics, hash, derived
floorspec canonicalize house.floorspec.json      # the canonical form (9.2)
floorspec hash house.floorspec.json              # the content hash (9.3)
floorspec derive house.floorspec.json            # derived walls, junction fills, rooms and openings
```

Exit status: 0 valid, 1 invalid, 2 usage or I/O error. `-` reads standard input. Its tests run the
built binary against the conformance suite vendored in `packages/engine/standard`.
