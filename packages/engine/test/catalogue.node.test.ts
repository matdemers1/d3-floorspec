import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATALOGUE } from '../src/validate/catalogue.js';

/** The catalogue (10.4) as the vendored spec states it: code and severity of every table row. */
function specCatalogue(): { code: string; severity: string }[] {
  const md = readFileSync(join(import.meta.dirname, '..', 'standard', 'spec', 'core', '10-diagnostics.md'), 'utf8');
  const section = md.slice(md.indexOf('## 10.4'), md.indexOf('## 10.5'));
  return [...section.matchAll(/^\| `(FS-[A-Z]+-\d{3})` \| (error|warning|info) \|/gm)].map((m) => ({ code: m[1]!, severity: m[2]! }));
}

describe('diagnostic catalogue', () => {
  it('lists exactly the codes and severities of spec/core/10-diagnostics.md, in order', () => {
    const spec = specCatalogue();
    expect(spec.length).toBeGreaterThan(40);
    expect(CATALOGUE.map((c) => ({ code: c.code, severity: c.severity }))).toEqual(spec);
  });
});
