import { readFileSync } from 'node:fs';
import { describe as group, expect, it } from 'vitest';
import { describe } from '../src/summary/index.js';

/** FLR-T-13.10: floorspec_describe lists a model's saved views (FS_views 0.1.0) with their lens, cutaway, sky and lights. */

type Json = Record<string, unknown>;
const RANCH = JSON.parse(readFileSync(new URL('./fixtures/two-bedroom-ranch.json', import.meta.url), 'utf8')) as Json;
const M = 1_280_000;

group('saved views in a description', () => {
  it('lists each view, and says how to render one', () => {
    const doc = {
      ...RANCH,
      floorspec: '0.4',
      extensionsUsed: { FS_views: '0.1.0' },
      extensions: { FS_views: { views: { SV1: { name: 'Front', eye: [-10 * M, -10 * M, 1.6 * M], target: [0, 0, 1.5 * M], focalLength: 24, twoPoint: true, at: '2026-06-21T17:00', exposure: 3 } } } },
    };
    const text = describe(doc);
    expect(text).toContain('## Saved views (FS_views; floorspec_render view: <name> renders one)');
    expect(text).toContain('- SV1 "Front": 24 mm · 3:2 · two-point · +0.3 EV; whole house; clear at 2026-06-21T17:00; lights off');
    expect(describe(RANCH)).not.toContain('Saved views');
  });
});
