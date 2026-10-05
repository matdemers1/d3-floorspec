import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { OpUnion } from '../src/ops-schema.js';

/**
 * The typed tool inputs advertise exactly the members the standard's own schema allows for each
 * operation (the vendored `packages/ops/standard/schema/ops/0.1`, the source of truth): a member the
 * applier accepts but the tool schema refuses is an edit the agent cannot make.
 */
const schema = JSON.parse(readFileSync(join(import.meta.dirname, '../../ops/standard/schema/ops/0.1/operation.schema.json'), 'utf8')) as {
  $defs: Record<string, { properties?: Record<string, unknown>; required?: string[] }>;
};

describe('the Ops input schema', () => {
  for (const option of OpUnion.options) {
    const op = option.shape.op.value;
    it(`${op} has the members of the vendored schema`, () => {
      const def = schema.$defs[op];
      expect(def?.properties, `the vendored schema defines ${op}`).toBeDefined();
      expect(Object.keys(option.shape).sort()).toEqual(Object.keys(def?.properties ?? {}).sort());
      const required = Object.entries(option.shape as Record<string, z.ZodType>).filter(([, s]) => !s.safeParse(undefined).success).map(([k]) => k).sort();
      expect(required).toEqual([...(def?.required ?? [])].sort());
    });
  }
});
