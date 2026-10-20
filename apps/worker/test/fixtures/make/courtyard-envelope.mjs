// FLR-T-16.4: writes courtyard-house-envelope.json — the Courtyard House on its street
// (courtyard-house-on-its-street.json, FLR-T-15.3) with its thermal envelope described by FS_thermal 0.1.0
// (FLR-ADR-066), for the board's "16.4 · Wall type — layer by layer", "Heat loss room by room" and
// "Heat-loss map in 3D", in Atlanta (the site's own location: the nearest station, zone 3A):
//
// - every material the thermal library knows takes its typical values (CC0, cited on the material); the
//   "Wood stud framing" material is the framing lumber, and the insulated cavities are fibreglass batts;
// - both 2x6 exterior wall types are framed 23% (16 in on centre with plates and headers); the brick
//   veneer's air space gets a ventilated-gap material;
// - every window type is rated U 1.70 W/(m2.K) (U-0.30) and SHGC 0.25, the exterior and glazed doors
//   U 1.99, the garage doors U 2.84;
// - the two shed roofs over the house: standing seam on OSB over 2 in of polyiso and 9 1/4 in of batts
//   between rafters framed 10%, a gypsum ceiling; the garage's flat roof is left without;
// - the ground floor's rooms: a 4 in slab with R-10 at its edge; the upper floor's: oak on OSB over
//   9 1/4 in of batts between joists framed 12%.
//
// Nothing about the house's geometry changes. Run from the repository root after building the engine and
// the analysis:
//   node apps/worker/test/fixtures/make/courtyard-envelope.mjs apps/worker/test/fixtures/courtyard-house-envelope.json
import { readFileSync, writeFileSync } from 'node:fs';
const E = await import(process.cwd() + '/packages/engine/dist/index.js');
const A = await import(process.cwd() + '/packages/analysis/dist/index.js');
const IN = 32512;
const d = JSON.parse(readFileSync('apps/worker/test/fixtures/courtyard-house-on-its-street.json', 'utf8'));
d.project = { ...d.project, name: 'Courtyard House — its thermal envelope' };
d.extensionsUsed.FS_thermal = '0.1.0';
const put = (el, data) => { el.extensions = { ...(el.extensions ?? {}), FS_thermal: data }; };

// Materials: the library's typical values; the framing lumber; two new ones.
const item = (id) => A.thermalItem(id);
for (const [id, m] of Object.entries(d.materials)) {
  const it = id === 'wood-stud-framing' ? item('softwood-framing') : A.thermalMatch(id, m);
  if (it) put(m, A.thermalData(it));
}
d.materials['air-space-ventilated'] = { name: 'Ventilated air space', color: '#20242a' };
put(d.materials['air-space-ventilated'], A.thermalData(item('rainscreen-gap')));
d.materials['polyiso-board'] = { name: 'Polyisocyanurate board', color: '#e8e2c8' };
put(d.materials['polyiso-board'], A.thermalData(item('polyiso')));

// Wall types.
for (const id of ['wall-2x6-exterior-fibre-cement', 'wall-2x6-exterior-brick-veneer']) put(d.types[id], { framing: { material: 'wood-stud-framing', fraction: 230 } });
for (const l of d.types['wall-2x6-exterior-brick-veneer'].layers) if (l.function === 'airGap' && l.material === undefined) l.material = 'air-space-ventilated';

// Doors and windows.
for (const [id, t] of Object.entries(d.types)) {
  if (t.kind === 'windowType') put(t, { uFactor: 1700, shgc: 250 });
  if (t.kind === 'doorType' && id.startsWith('door-garage')) put(t, { uFactor: 2840 });
  else if (t.kind === 'doorType' && (id.startsWith('door-exterior') || id.startsWith('door-double-swing'))) put(t, id.startsWith('door-double-swing') ? { uFactor: 1990, shgc: 250 } : { uFactor: 1990 });
}

// Roofs over the house.
const roof = {
  layers: [
    { thickness: IN / 32, function: 'finish', material: 'standing-seam-metal' },
    { thickness: IN / 64, function: 'membrane', material: 'weather-resistive-barrier' },
    { thickness: (5 * IN) / 8, function: 'substrate', material: 'osb-sheathing' },
    { thickness: 2 * IN, function: 'insulation', material: 'polyiso-board' },
    { thickness: (37 * IN) / 4, function: 'core', material: 'wood-stud-framing-insulated' },
    { thickness: IN / 2, function: 'finish', material: 'gypsum-board' },
  ],
  framing: { material: 'wood-stud-framing', fraction: 100 },
};
for (const id of ['RF1', 'RF2']) put(d.roofs[id], structuredClone(roof));

// Floors.
const conditioned = (r) => r.function !== 'garage' && r.function !== 'exterior';
for (const r of Object.values(d.rooms)) {
  if (!conditioned(r)) continue;
  if (r.level === 'L1') put(r, { floor: { layers: [{ thickness: 4 * IN, function: 'core', material: 'cast-in-place-concrete' }], edgeResistance: 1761 } });
  else
    put(r, {
      floor: {
        layers: [
          { thickness: (3 * IN) / 4, function: 'finish', material: 'white-oak-floor' },
          { thickness: (23 * IN) / 32, function: 'substrate', material: 'osb-sheathing' },
          { thickness: (37 * IN) / 4, function: 'core', material: 'wood-stud-framing-insulated' },
          { thickness: IN / 2, function: 'finish', material: 'gypsum-board' },
        ],
        framing: { material: 'wood-stud-framing', fraction: 120 },
      },
    });
}

const reader = { extensions: E.OFFICIAL_EXTENSION_NAMES, knownExtensions: E.OFFICIAL_EXTENSIONS };
const r = E.check(d, reader);
if (!r.valid) throw new Error('not valid: ' + JSON.stringify(r.diagnostics.filter((x) => x.severity === 'error')));
console.log(r.diagnostics.filter((x) => x.code.startsWith('FS-THRM') || x.code === 'FS-LINT-006').map((x) => `${x.code} ${x.elements.join(',')}`).join('\n'));
const e = A.estimateEnergy(d);
console.log(e.climate.label);
for (const a of e.envelope) console.log(`${a.key}: ${a.rEffective === null ? '?' : A.rText(a.rEffective)} ${a.u === null ? '' : A.uText(a.u)}${a.framing ? ` framing ${a.framing.fraction}` : ''}`);
console.log(`heating ${A.loadRange(e.loads.heating, 'imperial').text} kBtu/h, cooling ${A.loadRange(e.loads.cooling, 'imperial').text} kBtu/h`);
for (const x of e.rooms) console.log(`${x.room} ${x.name}: ${A.roomRange(x.heating, 'imperial')} heat, ${A.roomRange(x.cooling, 'imperial')} cool, ${x.perArea.toFixed(1)} Btu/h ft2 ${x.band}`);
writeFileSync(process.argv[2], JSON.stringify(d, null, 2) + '\n');
