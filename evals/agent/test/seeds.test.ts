import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyBatches, emptyDocument, hashOf, seedBatches, seedDocument, SEEDS_DIR } from '../src/seeds.js';

/**
 * What the harness checks against a live server: a project is created at the server's empty
 * document (Core 0.2 now), each seed's batches are applied to it, and main must land exactly at the
 * seed's hash — a Core 0.1 seed included, which its batch sets back to 0.1.
 */
describe('seeding a project', () => {
  for (const file of readdirSync(SEEDS_DIR).filter((f) => f.endsWith('.json'))) {
    it(`${file} lands at its own hash from the server's empty document`, () => {
      const seed = file.replace(/\.json$/, '');
      const landed = applyBatches(emptyDocument('A new project'), seedBatches(seed));
      expect(hashOf(landed)).toBe(hashOf(seedDocument(seed)));
    });
  }

  it("starts from the document the server creates a project with", () => {
    expect(emptyDocument('x')).toEqual({ floorspec: '0.3', project: { name: 'x' } });
  });
});
