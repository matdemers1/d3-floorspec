import { describe, expect, it } from 'vitest';
import { emptyDocument as serverEmptyDocument } from '../../../apps/server/src/model/document.js';
import { applyBatches, emptyDocument, expectedSeedHash, hashOf, recordedSeedHashes, seedBatches, seedDocument, seedNames } from '../src/seeds.js';

/**
 * What the harness checks against a live server: a project is created at the server's empty
 * document, each seed's batches are applied to it, and main must land exactly at the seed's
 * recorded hash — a Core 0.1 document seed included, which its batch sets back to 0.1. (The
 * integration job in CI does the same through the API itself, with `eval --agent reference`.)
 */
describe('seeding a project', () => {
  for (const seed of seedNames()) {
    it(`${seed} lands at its recorded hash from the server's empty document`, () => {
      const landed = applyBatches(emptyDocument('A new project'), seedBatches(seed));
      expect(hashOf(landed)).toBe(hashOf(seedDocument(seed)));
      expect(hashOf(landed)).toBe(recordedSeedHashes()[seed]);
      expect(expectedSeedHash(seed)).toBe(recordedSeedHashes()[seed]);
    });
  }

  it('records a hash for every seed, and for nothing else', () => {
    expect(Object.keys(recordedSeedHashes()).sort()).toEqual(seedNames());
  });

  // FLR-T-12.42: FLR-T-11.3 moved new projects to Core 0.4 and left the harness's copy at 0.3, so
  // the Ops seed landed somewhere else on the server and tasks 027–035 stopped before running.
  it('starts from exactly the document the server creates a project with', () => {
    expect(emptyDocument('x')).toEqual(serverEmptyDocument('x'));
  });

  it('refuses a seed that no longer computes to its recorded hash, or has none', () => {
    const seed = 'two-storey-colonial.ops';
    // What the colonial was recorded at while new projects were Core 0.3 (before FLR-T-11.3).
    const asCore03 = hashOf(applyBatches({ floorspec: '0.3', project: { name: 'x' } }, seedBatches(seed)));
    expect(asCore03).not.toBe(recordedSeedHashes()[seed]);
    expect(() => expectedSeedHash(seed, { [seed]: asCore03 })).toThrow(/now computes to .* but seed-hashes\.json records/);
    expect(() => expectedSeedHash(seed, {})).toThrow(/no recorded hash/);
  });
});
