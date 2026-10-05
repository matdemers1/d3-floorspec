# @floorspec/engine

The reference Reader, Canonicalizer, Validator and Deriver of Floorspec Core 0.3 — which reads Core
0.2 and 0.1 documents too, each with its own draft's schema and hash (1.2.6). Isomorphic: the same package runs in the
browser, the server, MCP and the CLI (FLR-ADR-010) — no Node APIs in `src/`.

```ts
import { check, validate, canonicalize, contentHash, derive, parseJson, planarize, OFFICIAL_EXTENSIONS, OFFICIAL_EXTENSION_NAMES, defaultClearances } from '@floorspec/engine';

validate(bytesOrTextOrValue);        // { valid, diagnostics } — chapter 10, tiers in order
check(bytesOrTextOrValue);           // + hash, derived, canonical for a valid document (conformance shape)
canonicalize(doc); contentHash(doc); // 9.2, 9.3
derive(input);                       // chapters 5–7 and 11–14; throws InvalidDocumentError if not valid
planarize({ junctions, edges, mintJunction, mintEdge }); // snap rounding (5.3 note)

// Options, on validate / check / derive / evaluate:
check(input, { knownExtensions: registryEntries }); // 12.2: an array of registry entries (value, text or bytes);
                                                    // a bad registry → FS-CFG-001 alone
check(input, { core: '0.2' });                      // a Core 0.2 reader: rejects "0.3"
check(input, { core: '0.1' });                      // a Core 0.1 reader: rejects "0.2" and "0.3", derives no 0.2 members
check(input, { extensions: ['FS_x'] });             // 1.6.4: extensions this reader implements (none by default)

// The official extensions (FS_electrical, FS_plumbing, FS_mechanical, FS_lowvoltage 0.1.0):
check(input, { extensions: OFFICIAL_EXTENSION_NAMES, knownExtensions: OFFICIAL_EXTENSIONS });
//   → their FS-ELEC-/FS-PLMB-/FS-MECH-/FS-LOWV- diagnostics, and derived.extensions.<NAME>
//     (circuits with connected load, panels, control links, stacks, gas load, head-end runs, devices by room)
defaultClearances('FS_electrical', 'panels', element);  // Floorspec's default envelopes for a new element
```

An official extension is **evaluated** for a document that declares "0.2" or "0.3" (its 0.1.0
spec, 1.1 and 1.2) and uses it at a version
the reader implements (`extensions`) and the validator knows (`knownExtensions`) — each extension's
spec, 1.2. Its schema is checked, then its invariants, after Core's and only without a Core error;
its lints only for a valid document. A reader that implements one gets `derived.extensions` (empty
when nothing was evaluated); a core-only reader never does. The implementations are in
`src/extensions/fs/`, each registered by name and version in `src/extensions/official.ts`, with its
schema's standalone validator and types generated from `standard/registry/`.

A 0.2 or 0.3 reader's `derived` has six more members — `program`, `fallbacks`, `placements`,
`clearances`, `clearanceOverlaps`, `circulation` (conformance/README.md) — present for a 0.1
document too: empty, except `circulation`, which needs no 0.2 member (14). Core 0.3 adds a door or
window type's `operation` and the declared net clear opening (`clearOpening` on a type, overridable
whole on an opening): `derived.openings[O].clearOpening` is the effective one, exactly as declared,
present only when one resolves (7.4) — never computed. `effectiveClearOpening(doc, opening)` and
`openingDimensions(doc, opening)` resolve them (8.2).

A 0.3 reader also derives, for a document of any draft, every room's floor and ceiling and every
slab (chapter 15, `src/slabs/floors.ts`): `derived.floors[R]` (top, bottom, box),
`derived.ceilings[R]` (kind, low, high, box, and a tray's centre) and `derived.slabs[S]` (outline,
top, bottom, box) — from a room's `floor` and `ceiling`, a level's `floorThickness` and
`ceilingHeight`, and their defaults. A vault's elevation is exact in one radicand and a tray's
centre is the room polygon moved in by its border, rounded once; FS-INV-701 to 703 check them. A
`surface` host sits on its room's floor top or under its ceiling at its position (15.6). A 0.2 or
0.1 reader (`core: '0.2'`, `'0.1'`) derives none of these members.

It also derives `derived.roofs[RF]` (kind, eave outline, eave, and the surface — faces, gable ends,
ridges, hips and valleys — or `null` where the draft does not derive one, with FS-LINT-015) and
`derived.stairs[ST]` (risers, riserHeight, rise, bottom, top, foot and head and their rooms, box,
and for a straight, L or U stair its steps, run, walkline and headroom; FS-LINT-016 for a winder or
a spiral). A stair links its foot room and head room in the door graph, and a building with a stair
no longer joins its levels through rooms of function `circulation`.

| Directory | What |
|---|---|
| `src/exact` | BigInt helpers and `Surd`: exact numbers in ℚ(√r₁…√r_k), exact sign, floor and round-half-to-even; `angle.ts`: F(θ) and the direction of a vector (13.1) in BigInt fixed point |
| `src/geometry` | integer predicates (5.3), exact face lines and corners (5.5), the half-edge structure (6.1), planarize |
| `src/derive` | per-level geometry (wedges, face ends, joins, fills, rooms), the program (11), frames, footprints and overlaps (13), and the `derived` output |
| `src/roofs` | roofs (16): edges, the eave outline, FS-INV-801 … 805, FS-LINT-015, and flat, shed and equal-pitch surfaces — the last by the oracle's wavefront sweep on integers ×4 |
| `src/stairs` | stairs (17): the layout in the stair's frame, foot and head rooms, rise and riser count, steps, run, walkline, headroom over lanes, FS-INV-901 … 904, FS-LINT-016, and the door-graph links a stair adds (14.1) |
| `src/circulation` | the door graph, entries, reachable rooms and sleeping rooms reached only through another (14), and the lints FS-LINT-012 … 014 |
| `src/extensions` | the official extensions: the shared context (one space of IDs, the room of an element), their registry (`official.ts`), default clearances, and one module each in `fs/` |
| `src/validate` | the tiers, the invariants (`invariants02.ts`: program, extension, hosting), the lints, known extensions and version ranges (`registry.ts`), and `catalogue.ts` — the single table of codes |
| `src/json`, `src/hash`, `src/canonical` | strict I-JSON parser, RFC 8785 writers, SHA-256, canonical form |
| `src/generated` | types, standalone schema validators (Core 0.1, 0.2 and 0.3, registry entry, each official extension), the official registry entries and the bundled 0.3 schema, generated from `standard/` |
| `standard/` | the floorspec schemas (core 0.1, 0.2 and 0.3, registry 0.1), the three Core conformance suites and the catalogue, and the registry (`registry/`: the official extensions' entries, specs and schemas) with their suites (`conformance/ext/`), vendored at the commit in `LOCK.json` |

```sh
pnpm --filter @floorspec/engine sync-standard [../floorspec] [--allow-dirty]   # re-vendor the standard
pnpm --filter @floorspec/engine generate          # regenerate src/generated from standard/schema
pnpm --filter @floorspec/engine check:generated   # CI: fails if regenerating changes anything
pnpm conformance                                  # every vendored case of every suite, must be 100%
pnpm --filter @floorspec/engine test:browser      # the same tests in headless Chromium, and Node≡browser
```

No float decides anything: every comparison and rounding is exact integer arithmetic. The only
floats are `Surd.approx()` (messages and debugging) and the `isqrt` bit-length guess, neither of
which reaches an output.
