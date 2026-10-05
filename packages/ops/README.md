# @floorspec/ops

The reference applier of **Floorspec Ops 0.1** (`../floorspec/spec/ops/`): every change to a
Floorspec document is a batch of operations applied as one transaction (FLR-ADR-008). Isomorphic
like `@floorspec/engine`, which it is built on (FLR-ADR-010): the editor, the server, the MCP
server and the CLI apply the same edit to the same bytes.

```ts
import { apply, resolveBatch, parseLength, formatLength } from '@floorspec/ops';

const r = apply(modelJson, {
  batch: [{ op: 'resizeRoom', room: 'Kitchen', side: 'east', by: "2'" }],
  context: { locks: [{ element: 'R5' }], retired: ['W9'] },
});
if (r.status === 'committed') {
  r.document; // B, canonical form (Core §9.2) — the exact bytes to store
  r.hash; // B's content hash (Core §9.3)
  r.resolved; // the primitives applied, every reference resolved (1.4) — the op log entry
  r.created; r.removed; // element IDs
  r.inverse; // the batch that turns B back into A (1.6) — undo
} else r.diagnostics; // FS-OPS-0xx, or the Core errors of the result (1.2.3)

resolveBatch(modelJson, request); // resolve + expand without committing: for echoes and proposals
parseLength(`12' 6 1/2"`); // { ok, value: 4893056n, exact, roundedBy }
formatLength(4893056); // `12' 6 1/2"` (1/16" by default); { system: 'metric' } → `3822.7 mm`
```

## Layout

| Path | |
|---|---|
| `src/apply.ts` | the six-step transaction (1.2), `apply` and `resolveBatch` |
| `src/request.ts` | the request's shape (1.1.1, FS-OPS-001) |
| `src/expand.ts` | resolve, expand and apply one operation: primitives and every composite (ch. 4) |
| `src/primitives.ts` | addElement and shorthands, removeElement with the cascade table, setProperty, unsetProperty, moveJunction (ch. 2) |
| `src/references/` | the length grammar (`length.ts`), points, vectors, selectors, sides and positions (`resolve.ts`) (ch. 3) |
| `src/model/` | the working copy and ID minting (1.5), the faces of a level as selectors read them (3.4) |
| `src/normalize.ts` | 5.1 merge → 5.2 snap rounding (only on a level that breaks Core §5.3), splitting, re-hosting → 5.3 join cleanup |
| `src/locks.ts`, `src/inverse.ts` | locks (ch. 6); the inverse (1.6) |
| `src/types.ts` | request, operation and result types |
| `standard/` | the Ops conformance suite, schema and diagnostics chapter, vendored by `pnpm sync-standard` and pinned in `LOCK.json` |

## Exactness and determinism

No clock, no randomness, no floating point. A length string is an exact rational (BigInt) rounded
once, ties to even; positions, displacements and re-hosted offsets are `Surd`s from the engine
(integers and square roots), rounded once; crossings and hot pixels are exact rationals; every
predicate is integer arithmetic. IDs and member names are ordered by UTF-16 code units. The browser
project (`pnpm test:browser`) applies the same fixtures in Chromium and requires Node's bytes.

## Commands

```sh
pnpm --filter @floorspec/ops test            # unit tests (Node)
pnpm --filter @floorspec/ops test:browser    # the same in Chromium, plus Node-vs-browser byte equality
pnpm --filter @floorspec/ops conformance     # conformance/ops/0.1 from standard/
pnpm --filter @floorspec/ops sync-standard [../floorspec] [--allow-dirty]
```
