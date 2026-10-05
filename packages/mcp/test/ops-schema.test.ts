import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { Host, OP_NAMES, OpUnion } from '../src/ops-schema.js';
import { ROOM_FUNCTIONS } from '../src/vocabulary.js';

/**
 * The typed tool inputs advertise exactly the members the standard's own schema allows for each
 * operation (the vendored `packages/ops/standard/schema/ops/0.2`, the source of truth — the draft the
 * server's applier runs): a member the applier accepts but the tool schema refuses is an edit the
 * agent cannot make.
 */
const SCHEMA = join(import.meta.dirname, '../../ops/standard/schema/ops/0.2');
const schema = JSON.parse(readFileSync(join(SCHEMA, 'operation.schema.json'), 'utf8')) as {
  $defs: Record<string, { properties?: Record<string, { const?: string; enum?: string[] }>; required?: string[] }>;
};
const references = JSON.parse(readFileSync(join(SCHEMA, 'reference.schema.json'), 'utf8')) as {
  $defs: { host: { oneOf: { properties: Record<string, { const?: string; enum?: string[] }>; required: string[] }[] } };
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

  it('has every operation the vendored schema defines', () => {
    const vendored = Object.values(schema.$defs).flatMap((d) => (typeof d.properties?.['op']?.const === 'string' ? [d.properties['op'].const] : []));
    expect([...OP_NAMES].sort()).toEqual(vendored.sort());
  });

  it('moves an opening toward exactly the directions the vendored schema allows', () => {
    const toward = OpUnion.options.find((o) => o.shape.op.value === 'moveOpening')?.shape as Record<string, z.ZodType> | undefined;
    for (const value of schema.$defs['moveOpening']?.properties?.['toward']?.enum ?? []) expect(toward?.['toward']?.safeParse(value).success, value).toBe(true);
    expect(toward?.['toward']?.safeParse('up').success).toBe(false);
  });

  it('takes a host in exactly the modes and members the vendored schema gives', () => {
    for (const mode of references.$defs.host.oneOf) {
      const name = mode.properties['mode']?.const ?? '';
      const option = Host.options.find((o) => o.shape.mode.value === name);
      expect(option, name).toBeDefined();
      expect(Object.keys(option?.shape ?? {}).sort()).toEqual(Object.keys(mode.properties).sort());
      const required = Object.entries((option?.shape ?? {}) as Record<string, z.ZodType>).filter(([, s]) => !s.safeParse(undefined).success).map(([k]) => k).sort();
      expect(required).toEqual([...mode.required].sort());
    }
    expect(Host.options).toHaveLength(references.$defs.host.oneOf.length);
  });
});

describe('the room functions', () => {
  it('are exactly Core 4.1\'s terms, in its order', () => {
    const room = JSON.parse(readFileSync(join(import.meta.dirname, '../../engine/standard/schema/core/0.1/room.schema.json'), 'utf8')) as {
      $defs: { function: { anyOf: { enum?: string[] }[] } };
    };
    expect([...ROOM_FUNCTIONS]).toEqual(room.$defs.function.anyOf.find((a) => a.enum !== undefined)?.enum);
  });
});
