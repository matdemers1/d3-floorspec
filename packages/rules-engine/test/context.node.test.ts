/**
 * FS_context 0.1.0 (FLR-T-15.3, FS-CTXT-1.5.1): context is never the design, so no rule ever sees it. The
 * example pack evaluated on the garden on its street finds exactly what it finds on the same garden with
 * no street, no neighbours and no trees — the same rules evaluated, the same subjects, the same findings.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OFFICIAL_EXTENSIONS } from '@floorspec/engine';
import { evaluate, type Pack } from '../src/index.js';

const pack = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'standard', 'rules', 'example', 'generated', 'pack.json'), 'utf8')) as Pack;
const street = join(import.meta.dirname, '..', '..', 'engine', 'standard', 'conformance', 'ext', 'FS_context', '0.1.0', 'examples', '001-p15-garden-on-its-street', 'input.json');
type Json = Record<string, unknown>;

const adopts = [...new Map(Object.values(pack.rules).map((r) => [`${r.citation.code} ${r.citation.edition}`, { code: r.citation.code, edition: r.citation.edition }])).values()];
const run = (doc: Json) =>
  evaluate(JSON.stringify(doc), { floorspecRules: '0.2', packs: [pack], profile: { floorspecRules: '0.2', name: 'Every example rule', adopts } }, { knownExtensions: [...OFFICIAL_EXTENSIONS] });

describe('FS_context and the rules', () => {
  it('finds nothing more and nothing less with context than without it', () => {
    const withContext = JSON.parse(readFileSync(street, 'utf8')) as Json & { extensionsUsed: Json; extensions: Json };
    // a neighbour over the Kitchen: if a rule could see context, this is where it would
    ((withContext.extensions['FS_context'] as Json)['neighbours'] as Json)['NB3'] = { boundary: [[390144, 390144], [3901440, 390144], [3901440, 3901440], [390144, 3901440]], height: 3901440 };
    const without = structuredClone(withContext);
    delete without.extensionsUsed['FS_context'];
    delete without.extensions['FS_context'];
    const a = run(withContext);
    const b = run(without);
    expect(a.evaluated).toEqual(b.evaluated);
    expect(a.notEvaluated).toEqual(b.notEvaluated);
    expect(a.findings).toEqual(b.findings);
    expect(JSON.stringify(a.findings)).not.toMatch(/NB3|ST1|TR1/);
  });
});
