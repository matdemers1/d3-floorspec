/**
 * The official extensions' Ops cases (FLR-ADR-025): each extension suite's `ops` group — moving a
 * wall with devices on it, removing a load a circuit still lists — applied by an applier that
 * implements that one extension and knows it at the case's registry entry, exactly as the
 * extension's conformance README says. The suites are vendored once, beside the engine
 * (packages/engine/standard/conformance/ext, at the commit in its LOCK.json).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXTENSION_IMPLEMENTATIONS, OFFICIAL_EXTENSION_NAMES, OFFICIAL_READER } from '@floorspec/engine';
import { apply } from '../src/index.js';
import { checkCase } from './check.js';
import { EXT_SUITES } from './suite.js';

const EXT = EXT_SUITES;

/** Every case directory that holds an apply request. */
function opsCases(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...opsCases(p));
    else if (entry === 'request.json') out.push(dir);
  }
  return out;
}

const read = (dir: string, file: string) => new Uint8Array(readFileSync(join(dir, file)));

for (const name of OFFICIAL_EXTENSION_NAMES) {
  const version = EXTENSION_IMPLEMENTATIONS.get(name)!.version;
  const suite = join(EXT, name, version);
  const cases = opsCases(suite);

  describe(`${name} ${version}: its Ops cases, applied by an applier that implements it`, () => {
    it('has Ops cases vendored', () => {
      expect(cases.length).toBeGreaterThan(0);
    });

    it.each(cases.map((d) => [relative(suite, d), d]))('%s', (_case, dir) => {
      const output = join(dir, 'output.json');
      const c = {
        name: relative(suite, dir),
        input: read(dir, 'input.json'),
        request: read(dir, 'request.json'),
        expected: readFileSync(join(dir, 'expected.json'), 'utf8'),
        output: existsSync(output) ? readFileSync(output, 'utf8') : null,
      };
      const result = apply(c.input, c.request, { extensions: [name], knownExtensions: read(dir, 'registry.json') });
      const problems = checkCase(c, result);
      expect(problems, problems.join('\n')).toEqual([]);
    });
  });
}

describe('an applier that implements every official extension (OFFICIAL_READER)', () => {
  const dir = join(EXT, 'FS_electrical', '0.1.0', 'ops', '002-remove-a-load-is-rejected');

  it('rejects a batch that breaks an extension invariant', () => {
    const r = apply(read(dir, 'input.json'), read(dir, 'request.json'), OFFICIAL_READER);
    expect(r.status).toBe('rejected');
    expect(r.status === 'rejected' ? r.diagnostics.map((d) => d.code) : []).toEqual(['FS-ELEC-INV-003']);
  });

  it('and a core-only applier commits it, judging only Core', () => {
    expect(apply(read(dir, 'input.json'), read(dir, 'request.json')).status).toBe('committed');
  });
});
