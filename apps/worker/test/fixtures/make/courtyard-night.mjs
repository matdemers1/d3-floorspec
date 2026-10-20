// FLR-T-15.5: writes courtyard-night.json, the Courtyard House with its grounds lit — the board's "15.5 · Night
// exterior". The electrical assistant's exterior proposal (path lights along the walks and the drive, a wall-washer
// at the unlit entry, the transformer, its control and the "Evening exterior" scene), then by hand: uplights into
// the canopies of the trees, wall-washers on the courtyard's walls, string lights over the courtyard and the back
// terrace, and a "Night exterior" scene — every exterior light on at 2700 K and the great room and kitchen glowing
// low behind their glass. Every change is an Op, applied by the reference applier. Run from the repository root
// after building: node apps/worker/test/fixtures/make/courtyard-night.mjs apps/worker/test/fixtures/courtyard-night.json
import { readFileSync, writeFileSync } from 'node:fs';
const root = process.cwd();
const E = await import(`${root}/packages/engine/dist/index.js`);
const O = await import(`${root}/packages/ops/dist/index.js`);
const A = await import(`${root}/packages/assistants/electrical/dist/index.js`);
const X = await import(`${root}/packages/render2d/dist/exterior.js`);

const IN = 32_512;
const FT = 12 * IN;
const src = readFileSync('apps/worker/test/fixtures/courtyard-house.json', 'utf8');
const commit = (doc, batch, what) => {
  const r = O.apply(doc, { batch }, E.OFFICIAL_READER);
  if (r.status !== 'committed') throw new Error(`${what}: ${r.diagnostics.map((d) => `${d.code} ${d.message}`).join('; ')}`);
  return r.document;
};

// 1. The assistant's proposal, accepted as it stands.
const proposal = A.proposeExterior(src, { level: 'L1' });
let doc = commit(src, proposal.batch, 'the assistant’s proposal');
const evening = proposal.exterior.scene.id;

// 2. By hand: each an exterior light of a kind, placed by an op, with its photometry in FS_lighting.
const added = [];
const used = new Set(Object.keys(JSON.parse(doc).extensions.FS_electrical.collections.lights));
let n = 0;
const mint = () => {
  for (;;) {
    const id = `XN${String(++n)}`;
    if (!used.has(id)) return id;
  }
};
const batch = [];
const light = (kind, host, patch = {}, box, lumens) => {
  const id = mint();
  const def = X.EXTERIOR_DEFS[kind];
  batch.push({ op: 'placeElement', extension: 'FS_electrical', collection: 'lights', id, host, element: { fallback: { box: box ?? structuredClone(def.box) }, ...X.exteriorMembers(kind, patch) } });
  batch.push({ op: 'setProperty', id: '$document', path: `/extensions/FS_lighting/luminaires/${id}`, value: { lumens: lumens ?? (kind === 'string' ? def.lumens * X.bulbCount(box.max[0] - box.min[0]) : def.lumens), cct: kind === 'string' ? 2200 : 2700, dimmable: true } });
  added.push(id);
  return id;
};
const deg = (d) => Math.round(d) * 1_000_000;
const towards = (from, to) => deg((Math.atan2(to[1] - from[1], to[0] - from[0]) * 180) / Math.PI);
const plants = JSON.parse(doc).extensions.FS_landscape.collections.plants;
// Uplights into each tree's canopy: just outside its edge on the sides the house and the walks look from, aimed at
// its trunk — a big canopy given a brighter lamp.
const uplight = (tree, angles, spread, lumens, out) => {
  const t = plants[tree];
  const c = t.host.position;
  const r = Math.round(t.fallback.box.max[0] * out);
  for (const a of angles) {
    const p = [Math.round(c[0] + r * Math.cos((a * Math.PI) / 180)), Math.round(c[1] + r * Math.sin((a * Math.PI) / 180))];
    light('uplight', { mode: 'free', level: 'L1', at: p, rotation: towards(p, c) }, { beam: spread, reach: r }, undefined, lumens);
  }
};
uplight('LS-T1', [-40, -150], 40, 700, 1.15); // the courtyard's tree, from the great room and the front walk
uplight('LS-T2', [20, 110, -70], 40, 1000, 1.15); // the big front tree, from the walk, the house and the street
uplight('LS-T3', [-150], 25, 500, 2);
uplight('LS-T4', [150], 25, 500, 2);
// Wall-washers on the courtyard's faces, 6' up, between its openings.
const plan = A.readPlan(doc, { grid: IN });
const clearAt = (wall, at) => A.holesIn(plan.document, wall).every((h) => at + 6 * IN <= h.from - 4 * IN || at - 6 * IN >= h.to + 4 * IN);
const washers = [
  ['W1', 'left', [0.2, 0.5, 0.8]],
  ['W22', 'left', [0.2, 0.5, 0.8]],
  ['W21', 'left', [0.12, 0.5, 0.88]],
];
const lengthOf = (wall) => {
  const w = plan.document.walls[wall];
  const [a, b] = [plan.document.junctions[w.start].position, plan.document.junctions[w.end].position];
  return Math.floor(Math.hypot(b[0] - a[0], b[1] - a[1]));
};
for (const [wall, side, fs] of washers)
  for (const f of fs) {
    const at = Math.round((f * lengthOf(wall)) / IN) * IN;
    if (clearAt(wall, at)) light('wallWash', { mode: 'wallFace', wall, side, at, height: 6 * FT }, { beam: 60 });
  }
// String lights over the courtyard, three runs west to east 8' up, and two over the back terrace.
const run = (from, to) => {
  const len = Math.round(Math.hypot(to[0] - from[0], to[1] - from[1]));
  light('string', { mode: 'free', level: 'L1', at: from, rotation: towards(from, to) }, {}, X.stringBox(len));
};
for (const y of [8_200_000, 11_200_000, 14_200_000]) run([700_000, y], [12_900_000, y]);
for (const y of [11_000_000, 14_200_000]) run([24_600_000, y], [30_100_000, y]);

// 3. On the control, on a tap of the transformer, in the evening scene.
const now = JSON.parse(doc);
const control = proposal.added.switches[0];
batch.push({ op: 'setProperty', id: control, path: '/controls', value: [...now.extensions.FS_electrical.collections.switches[control].controls, ...added] });
const tap = 'CLV3';
batch.push({ op: 'setProperty', id: '$document', path: `/extensions/FS_electrical/circuits/${tap}`, value: { panel: proposal.exterior.transformer.id, breaker: 15, volts: 12, space: 3, loads: added, name: 'LV-3 · trees, walls and strings' } });
for (const id of added) batch.push({ op: 'setProperty', id: '$document', path: `/extensions/FS_lighting/scenes/${evening}/on/${id}`, value: {} });
// 4. "Night exterior": every exterior light, and the great room and kitchen low behind their glass.
const on = {};
for (const [id, l] of Object.entries(now.extensions.FS_electrical.collections.lights)) if (l.fixture === 'exterior') on[id] = {};
for (const id of added) on[id] = {};
for (const id of ['L-GR-PD', 'L-KIT-P1', 'L-KIT-P2']) on[id] = { output: 45, cct: 2400 };
for (const id of ['L-GR-R1', 'L-GR-R2', 'L-GR-R3', 'L-GR-R4']) on[id] = { output: 25 };
batch.push({ op: 'setProperty', id: '$document', path: '/extensions/FS_lighting/scenes/LS9', value: { name: 'Night exterior', on: Object.fromEntries(Object.entries(on).sort(([a], [b]) => (a < b ? -1 : 1))) } });
doc = commit(doc, batch, 'the lights by hand');

const out = JSON.parse(doc);
out.project = { ...out.project, name: 'Courtyard House — night exterior' };
const c = E.check(JSON.stringify(out), E.OFFICIAL_READER);
if (!c.valid) throw new Error(c.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`).join('\n'));
writeFileSync(process.argv[2] ?? "apps/worker/test/fixtures/courtyard-night.json", `${JSON.stringify(out, null, 2)}\n`);
console.log(`${String(proposal.added.lights.length)} proposed + ${String(added.length)} by hand`);
