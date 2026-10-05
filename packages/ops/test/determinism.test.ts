/** 1.3.2: the same batch, context and document give the same result, byte for byte, in every run. */
import { describe, expect, it } from 'vitest';
import { apply } from '../src/index.js';
import { fixtures } from './fixtures.js';

// Every fixture is applied several times in one test: allow for slow CI runners.
const EVERY_FIXTURE = 60_000;

describe('determinism (1.3.2)', () => {
  it('gives the same bytes on every run, and never mutates its inputs', () => {
    for (const f of fixtures()) {
      const before = JSON.stringify([f.doc, f.request]);
      const first = JSON.stringify(apply(f.doc, f.request));
      expect(JSON.stringify(apply(f.doc, f.request)), f.name).toBe(first);
      // The same document as JSON text gives the same result as the parsed value.
      expect(JSON.stringify(apply(JSON.stringify(f.doc), JSON.stringify(f.request))), f.name).toBe(first);
      expect(JSON.stringify([f.doc, f.request])).toBe(before);
    }
  }, EVERY_FIXTURE);

  it('puts no floating-point number in any output', () => {
    for (const f of fixtures()) {
      const r = apply(f.doc, f.request);
      JSON.stringify(r, (_k, v: unknown) => {
        if (typeof v === 'number') expect(Number.isSafeInteger(v), `${f.name}: ${v}`).toBe(true);
        return v;
      });
    }
  }, EVERY_FIXTURE);
});
