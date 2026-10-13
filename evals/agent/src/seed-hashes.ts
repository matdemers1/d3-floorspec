#!/usr/bin/env node
/**
 * The seeds' recorded hashes (FLR-T-12.42).
 *
 *   pnpm --filter @d3-floorspec/agent-eval seeds            # each seed's hash against its record
 *   pnpm --filter @d3-floorspec/agent-eval seeds --write    # re-record them, after an intended change
 *
 * Computed with the reference applier from the server's empty document, as test/seeds.test.ts and
 * the harness compute them. Re-record only for a change that was meant to move a seed, and say which
 * in the README's run log; the harness's own run (`eval --agent reference`) then proves the API
 * lands every seed there and every task still holds.
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { hashOf, recordedSeedHashes, SEED_HASHES_FILE, seedDocument, seedNames } from './seeds.js';

const { values } = parseArgs({ options: { write: { type: 'boolean', default: false } } });

const recorded = recordedSeedHashes();
const computed = Object.fromEntries(seedNames().map((name) => [name, hashOf(seedDocument(name))]));
let moved = 0;
for (const name of new Set([...Object.keys(recorded), ...Object.keys(computed)])) {
  const was = recorded[name];
  const now = computed[name];
  const same = was === now;
  if (!same) moved++;
  process.stdout.write(`${same ? 'same ' : 'MOVED'} ${name}: ${now ?? '(no seed file)'}${same ? '' : ` (recorded ${was ?? 'nothing'})`}\n`);
}
if (values.write) {
  writeFileSync(SEED_HASHES_FILE, `${JSON.stringify(computed, null, 2)}\n`);
  process.stdout.write(`recorded ${String(Object.keys(computed).length)} seed hash(es) in ${SEED_HASHES_FILE}\n`);
} else if (moved > 0) {
  process.exit(1);
}
