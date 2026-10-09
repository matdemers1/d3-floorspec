/**
 * The mesher in a real browser: manifold-3d's WASM fetched as an asset, and every byte a view would
 * receive — positions, indices, keys and boxes — the same as Node's.
 */
import { describe, expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import house from '../../engine/standard/conformance/core/0.3/examples/001-three-room-house/input.json' with { type: 'json' };
import lStair from '../../engine/standard/conformance/core/0.3/stairs/007-l-stair-with-landing/input.json' with { type: 'json' };
import lHip from '../../engine/standard/conformance/core/0.3/roofs/004-l-shaped-hip-roof/input.json' with { type: 'json' };
import vault from '../../engine/standard/conformance/core/0.3/floors/014-vaulted-ceiling-oblique-ridge/input.json' with { type: 'json' };
import showcase from './fixtures/showcase.floorspec.json' with { type: 'json' };
import { loadMesher } from '../src/index.js';
import { digest } from './digest.js';
import { ranch } from './houses.js';

describe('in the browser', () => {
  it('meshes exactly what Node meshes', async () => {
    const mesher = await loadMesher();
    // The showcase: every fixture model's round pieces, drawn from the circle table (FLR-T-12.21).
    for (const doc of [house, lStair, lHip, vault, ranch(), showcase]) {
      const text = JSON.stringify(doc);
      expect(digest(mesher.meshDocument(text))).toBe(await commands.meshDigestInNode(text));
    }
  });
});
