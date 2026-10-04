# @floorspec/engine

The reference Reader, Canonicalizer, Validator and Deriver of Floorspec Core 0.1. Isomorphic: the
same package runs in the browser, the server, MCP and the CLI (FLR-ADR-010) — no Node APIs in `src/`.

```ts
import { check, validate, canonicalize, contentHash, derive, parseJson, planarize } from '@floorspec/engine';

validate(bytesOrTextOrValue);        // { valid, diagnostics } — chapter 10, tiers in order
check(bytesOrTextOrValue);           // + hash, derived, canonical for a valid document (conformance shape)
canonicalize(doc); contentHash(doc); // 9.2, 9.3
derive(input);                       // chapters 5–7; throws InvalidDocumentError if not valid
planarize({ junctions, edges, mintJunction, mintEdge }); // snap rounding (5.3 note)
```

| Directory | What |
|---|---|
| `src/exact` | BigInt helpers and `Surd`: exact numbers in ℚ(√r₁…√r_k), exact sign, floor and round-half-to-even |
| `src/geometry` | integer predicates (5.3), exact face lines and corners (5.5), the half-edge structure (6.1), planarize |
| `src/derive` | per-level geometry (wedges, face ends, joins, fills, rooms) and the `derived` output |
| `src/validate` | the tiers, the invariants, the lints, and `catalogue.ts` — the single table of codes |
| `src/json`, `src/hash`, `src/canonical` | strict I-JSON parser, RFC 8785 writers, SHA-256, canonical form |
| `src/generated` | types, standalone schema validator and bundled schema, generated from `standard/` |
| `standard/` | the floorspec schema, conformance suite and catalogue, vendored at the commit in `LOCK.json` |

```sh
pnpm --filter @floorspec/engine sync-standard [../floorspec] [--allow-dirty]   # re-vendor the standard
pnpm --filter @floorspec/engine generate          # regenerate src/generated from standard/schema
pnpm --filter @floorspec/engine check:generated   # CI: fails if regenerating changes anything
pnpm conformance                                  # every vendored case, must be 100%
pnpm --filter @floorspec/engine test:browser      # the same tests in headless Chromium, and Node≡browser
```

No float decides anything: every comparison and rounding is exact integer arithmetic. The only
floats are `Surd.approx()` (messages and debugging) and the `isqrt` bit-length guess, neither of
which reaches an output.
