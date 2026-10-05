# @floorspec/engine

The reference Reader, Canonicalizer, Validator and Deriver of Floorspec Core 0.2 — which reads Core
0.1 documents too, with 0.1's schema and hash (1.2.4). Isomorphic: the same package runs in the
browser, the server, MCP and the CLI (FLR-ADR-010) — no Node APIs in `src/`.

```ts
import { check, validate, canonicalize, contentHash, derive, parseJson, planarize } from '@floorspec/engine';

validate(bytesOrTextOrValue);        // { valid, diagnostics } — chapter 10, tiers in order
check(bytesOrTextOrValue);           // + hash, derived, canonical for a valid document (conformance shape)
canonicalize(doc); contentHash(doc); // 9.2, 9.3
derive(input);                       // chapters 5–7 and 11–13; throws InvalidDocumentError if not valid
planarize({ junctions, edges, mintJunction, mintEdge }); // snap rounding (5.3 note)

// Options, on validate / check / derive / evaluate:
check(input, { knownExtensions: registryEntries }); // 12.2: an array of registry entries (value, text or bytes);
                                                    // a bad registry → FS-CFG-001 alone
check(input, { core: '0.1' });                      // a Core 0.1 reader: rejects "0.2", derives no 0.2 members
check(input, { extensions: ['FS_x'] });             // 1.6.4: extensions this reader implements (none by default)
```

A 0.2 reader's `derived` has five more members — `program`, `fallbacks`, `placements`,
`clearances`, `clearanceOverlaps` (conformance/README.md) — present, empty, for a 0.1 document.

| Directory | What |
|---|---|
| `src/exact` | BigInt helpers and `Surd`: exact numbers in ℚ(√r₁…√r_k), exact sign, floor and round-half-to-even; `angle.ts`: F(θ) and the direction of a vector (13.1) in BigInt fixed point |
| `src/geometry` | integer predicates (5.3), exact face lines and corners (5.5), the half-edge structure (6.1), planarize |
| `src/derive` | per-level geometry (wedges, face ends, joins, fills, rooms), the program (11), frames, footprints and overlaps (13), and the `derived` output |
| `src/validate` | the tiers, the invariants (`invariants02.ts`: program, extension, hosting), the lints, known extensions and version ranges (`registry.ts`), and `catalogue.ts` — the single table of codes |
| `src/json`, `src/hash`, `src/canonical` | strict I-JSON parser, RFC 8785 writers, SHA-256, canonical form |
| `src/generated` | types, standalone schema validators (Core 0.1, Core 0.2, registry entry) and the bundled 0.2 schema, generated from `standard/` |
| `standard/` | the floorspec schemas (core 0.1 and 0.2, registry 0.1), both conformance suites and the catalogue, vendored at the commit in `LOCK.json` |

```sh
pnpm --filter @floorspec/engine sync-standard [../floorspec] [--allow-dirty]   # re-vendor the standard
pnpm --filter @floorspec/engine generate          # regenerate src/generated from standard/schema
pnpm --filter @floorspec/engine check:generated   # CI: fails if regenerating changes anything
pnpm conformance                                  # every vendored case of both suites, must be 100%
pnpm --filter @floorspec/engine test:browser      # the same tests in headless Chromium, and Node≡browser
```

No float decides anything: every comparison and rounding is exact integer arithmetic. The only
floats are `Surd.approx()` (messages and debugging) and the `isqrt` bit-length guess, neither of
which reaches an output.
