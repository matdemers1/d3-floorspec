// FLR-T-16.1: writes courtyard-house-solar.json — the Courtyard House on its street (courtyard-house-on-its-street.json,
// FLR-T-15.3) with solar on its roofs (FS_energy 0.1.0, the board's "16.1 · Solar on the roof"): the solar assistant's
// proposal accepted as it stands — the faces ranked by a kW's typical year after shade, an array on the most productive
// one sized to the house's use, a hybrid inverter beside the panel in the garage, a rapid-shutdown initiator beside it
// and their circuit — and then an array a person placed on the guest wing's shed roof, which joins the inverter. Both
// shed roofs carry an array. Nothing else changes. Run from the repository root after building the packages:
//   node apps/worker/test/fixtures/make/courtyard-solar.mjs apps/worker/test/fixtures/courtyard-house-solar.json
import { readFileSync, writeFileSync } from 'node:fs';
const E = await import(process.cwd() + '/packages/engine/dist/index.js');
const O = await import(process.cwd() + '/packages/ops/dist/index.js');
const S = await import(process.cwd() + '/packages/assistants/solar/dist/index.js');
const A = await import(process.cwd() + '/packages/analysis/dist/index.js');

const commit = (doc, batch) => {
  const r = O.apply(doc, { batch }, E.OFFICIAL_READER);
  if (r.status !== 'committed') throw new Error('rejected: ' + JSON.stringify(r.diagnostics));
  return JSON.parse(r.document);
};

let d = JSON.parse(readFileSync('apps/worker/test/fixtures/courtyard-house-on-its-street.json', 'utf8'));
d.project = { ...d.project, name: 'Courtyard House — solar on the roof' };

const p = S.proposeSolar(d);
console.log(p.explanation.join('\n'));
d = commit(JSON.stringify(d), p.batch);

const hand = S.proposeSolar(d, { faces: ['RF2:2'] });
console.log(hand.explanation.join('\n'));
d = commit(JSON.stringify(d), hand.batch);

const r = E.check(d, E.OFFICIAL_READER);
if (!r.valid) throw new Error('not valid: ' + JSON.stringify(r.diagnostics.filter((x) => x.severity === 'error')));
console.log(r.diagnostics.filter((x) => x.code.startsWith('FS-ENGY')).map((x) => `${x.code} ${x.elements.join(',')}`).join('\n'));
const est = A.estimateSolar(d);
for (const a of est.arrays) console.log(`${a.id}: ${a.modules} modules, ${a.kw.toFixed(2)} kW, ${a.low}–${a.high} kWh/yr, ${Math.round(a.perKw)} kWh/kW, shade ${(a.shade * 100).toFixed(1)}% (${a.shadedBy.join(', ')})`);
console.log(`total ${est.total.low}–${est.total.high} kWh/yr`);
writeFileSync(process.argv[2], JSON.stringify(d, null, 2) + '\n');
