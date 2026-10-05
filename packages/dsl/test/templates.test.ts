/**
 * Round trips against the app's templates (FLR-T-10.5): a DSL description of each template compiles
 * to a document whose rooms — names, functions, exact net areas and polygons — and openings match
 * the template; and every template decompiles to DSL that compiles back to the same rooms.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { build, compile, DecompileError, toDsl } from '../src/index.js';
import { built, summarize } from './helpers.js';

const TEMPLATES = new URL('../../../apps/web/src/projects/templates/', import.meta.url);
const EXAMPLES = new URL('../examples/', import.meta.url);
const templates = readdirSync(TEMPLATES)
  .filter((f) => f.endsWith('.floorspec.json'))
  .sort()
  .map((f) => ({ id: f.replace(/\.floorspec\.json$/, ''), json: readFileSync(new URL(f, TEMPLATES), 'utf8') }));

/** The templates with a handwritten DSL description in examples/. */
const DESCRIBED = ['three-room-house'];

describe('templates', () => {
  test('the app has templates, and the handwritten descriptions name real ones', () => {
    expect(templates.length).toBeGreaterThan(0);
    for (const id of DESCRIBED) expect(templates.map((t) => t.id)).toContain(id);
  });

  for (const id of DESCRIBED)
    test(`${id}: the handwritten DSL compiles to the template's rooms and openings, exactly`, () => {
      const template = templates.find((t) => t.id === id)!;
      const text = readFileSync(new URL(`${id}.fsdsl`, EXAMPLES), 'utf8');
      const b = built(text);
      const want = summarize(template.json);
      const got = summarize(b.document);
      expect(Object.keys(got.rooms).sort()).toEqual(Object.keys(want.rooms).sort());
      expect(got.rooms).toEqual(want.rooms);
      expect(got.openings).toEqual(want.openings);
      expect(got.program).toEqual(want.program);
    });

  for (const t of templates)
    test(`${t.id}: template → DSL → document keeps every room and opening`, () => {
      let text: string;
      try {
        text = toDsl(t.json);
      } catch (e) {
        // A template the DSL cannot say must be refused loudly, never decompiled into another plan.
        expect(e).toBeInstanceOf(DecompileError);
        return;
      }
      const b = built(text);
      expect(summarize(b.document)).toEqual(summarize(t.json));
      // Decompiling what it compiled to says the same thing again.
      expect(toDsl(b.document)).toBe(text);
    });

  test('the three-room house decompiles (it is rectilinear)', () => {
    const t = templates.find((x) => x.id === 'three-room-house')!;
    expect(() => toDsl(t.json)).not.toThrow();
  });

  test('the blank template is the empty text', () => {
    const r = compile('');
    expect(r.ok && r.batch).toEqual([]);
    const b = build('# nothing yet\n');
    expect(b.ok).toBe(true);
    if (b.ok) expect(summarize(b.document).rooms).toEqual({});
  });
});
