# templates

The starter templates — a ranch, a two-storey house and a cabin (FLR-T-4.5, FLR-REQ-078) — are part of
the standard: `templates/` in `../floorspec`, each also a Core 0.3 conformance example
(`examples/004`–`006`). They are vendored with the rest of the standard into
`packages/engine/standard/templates/` by `pnpm --filter @floorspec/engine sync-standard`, at the commit
`packages/engine/standard/LOCK.json` pins, and offered in the new-project dialog by
`apps/web/src/projects/templates.ts` beside the three-room house. A project made from one receives it as
one batch of Floorspec Ops (`documentToBatch` in `@floorspec/package`).
