import { describe, expect, it } from 'vitest';
import { symbolDigests } from '../../src/routes/checks.js';

/** FLR-T-12.24: the plan render reads the bytes of the symbols a model's furniture names, and nothing else. */
describe('the plan symbols a render reads', () => {
  const A = 'a'.repeat(64);
  const B = 'b'.repeat(64);
  const doc = {
    assets: { SYM: { sha256: B, mediaType: 'image/svg+xml' }, OTHER: { sha256: A, mediaType: 'image/svg+xml' }, MODEL: { sha256: 'c'.repeat(64), mediaType: 'model/gltf-binary' } },
    extensions: {
      FS_furniture: { collections: { pieces: { BED: { fallback: { symbol: 'SYM', asset: 'MODEL' } }, SOFA: { fallback: { symbol: 'SYM' } } } } },
      FS_plumbing: { collections: { fixtures: { WC: { fallback: { symbol: 'OTHER' } }, LAV: { fallback: { symbol: 'MISSING' } } } } },
    },
  };

  it('collects every element’s fallback symbol digest, once each, sorted', () => {
    expect(symbolDigests(doc)).toEqual([A, B]);
  });

  it('ignores models, assets no element names as its symbol, and a document with none', () => {
    expect(symbolDigests({ assets: doc.assets })).toEqual([]);
    expect(symbolDigests(null)).toEqual([]);
    expect(symbolDigests({ extensions: { X: { collections: { c: { E: { fallback: { symbol: 'NOPE' } } } } } } })).toEqual([]);
  });

  it('refuses a digest that is not a lowercase hex SHA-256', () => {
    expect(symbolDigests({ assets: { S: { sha256: '../etc/passwd' } }, extensions: { X: { collections: { c: { E: { fallback: { symbol: 'S' } } } } } } })).toEqual([]);
  });
});
