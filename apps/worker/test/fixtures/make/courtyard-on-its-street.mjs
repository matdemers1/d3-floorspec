// FLR-T-15.3: writes courtyard-house-on-its-street.json — the Courtyard House with its back terrace
// (courtyard-house-outdoor.json, FLR-T-15.2) on its street (FS_context 0.1.0, the board's "15.3 · Context in 3D"):
// context generated from the lot's street edge — Laurel Ridge Drive on the west, a 30' carriageway with a 6" curb,
// a 4' planting strip and a 5' sidewalk each side, its sidewalk's back on the lot line — neighbours on the lots to
// the north and south at the lot's own 10' side setback and 30' front setback, one or two storeys with a gable or a
// hip, street trees in the strips and trees beyond the lot, all seeded so the same lot always gets the same street.
// Nothing about the house or its lot changes: context is never the design. Run from the repository root after
// building the engine:
//   node apps/worker/test/fixtures/make/courtyard-on-its-street.mjs apps/worker/test/fixtures/courtyard-house-on-its-street.json
import { readFileSync, writeFileSync } from 'node:fs';
const E = await import(process.cwd() + '/packages/engine/dist/index.js');
const FT = 390144;
const d = JSON.parse(readFileSync('apps/worker/test/fixtures/courtyard-house-outdoor.json', 'utf8'));
d.project = { ...d.project, name: 'Courtyard House — on its street' };

const g = E.generateContext(d, { seed: 14, name: 'Laurel Ridge Drive', trees: 'some' });
if (g.reason) throw new Error(g.reason);
d.extensionsUsed.FS_context = '0.1.0';
d.extensions.FS_context = { streets: g.streets, neighbours: g.neighbours, trees: g.trees };

const reader = { extensions: E.OFFICIAL_EXTENSION_NAMES, knownExtensions: E.OFFICIAL_EXTENSIONS };
const r = E.check(d, reader);
if (!r.valid) throw new Error('not valid: ' + JSON.stringify(r.diagnostics.filter((x) => x.severity === 'error')));
const x = r.derived.extensions.FS_context;
for (const [id, s] of Object.entries(x.streets)) console.log(`${id}: ${(s.length / FT).toFixed(1)}' long, ${(s.width / FT).toFixed(1)}' overall`);
for (const [id, n] of Object.entries(x.neighbours)) console.log(`${id}: ${n.roof}, ${(Number(n.area) / FT / FT).toFixed(0)} ft2, eaves ${(n.eaves / FT).toFixed(1)}', ridge ${(n.ridge / FT).toFixed(1)}'`);
console.log(`${Object.keys(x.trees).length} trees`);
console.log(r.diagnostics.filter((x) => x.code.startsWith('FS-CTXT')).map((x) => `${x.code} ${x.elements.join(',')}`).join('\n'));
writeFileSync(process.argv[2], JSON.stringify(d, null, 2) + '\n');
