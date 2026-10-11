/**
 * FLR-T-12.33: the FS_furniture starter library's proxy models, known by digest — the one place the
 * editor's 3D view and the worker's exports ask whether an element's model is a library proxy (drawn
 * as the procedural model instead) or a project's own (drawn as it is).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { furniture } from '../src/index.js';

const LIBRARY = join(import.meta.dirname, '..', 'standard', 'registry', 'FS_furniture', 'library');
const catalogue = JSON.parse(readFileSync(join(LIBRARY, 'library.json'), 'utf8')) as { items: Record<string, { model: { path: string; sha256: string } }> };

describe('the starter library’s proxy models', () => {
  it('knows every item’s model by the digest of its bytes', () => {
    const items = Object.entries(catalogue.items);
    expect(items.length).toBeGreaterThan(0);
    for (const [id, item] of items) {
      const digest = createHash('sha256').update(readFileSync(join(LIBRARY, item.model.path))).digest('hex');
      expect(digest, id).toBe(item.model.sha256);
      expect(furniture.starterLibraryItem(digest), id).toBe(id);
      expect(furniture.isStarterLibraryModel(digest), id).toBe(true);
    }
  });

  it('answers no for any other digest: a project’s own model', () => {
    const own = createHash('sha256').update('a model somebody made').digest('hex');
    expect(furniture.isStarterLibraryModel(own)).toBe(false);
    expect(furniture.starterLibraryItem(own)).toBeUndefined();
    for (const x of [undefined, null, 42, '', 'constructor', '__proto__', 'toString']) expect(furniture.isStarterLibraryModel(x)).toBe(false);
  });
});
