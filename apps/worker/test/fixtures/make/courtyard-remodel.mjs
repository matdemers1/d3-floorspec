// FLR-T-18.13: writes courtyard-remodel.json, a kitchen remodel of a copy of courtyard-house.json (FS_renovation):
// the pantry's walls, pocket door, room and the devices on them demolished, the east run of cabinets, the
// refrigerator and the old island demolished; a new feature wall, a new window, a new island and cooktop, and a
// new run of cabinets and refrigerator where the pantry was. Run from the repository root after building the
// engine: node apps/worker/test/fixtures/make/courtyard-remodel.mjs apps/worker/test/fixtures/courtyard-remodel.json
import { readFileSync, writeFileSync } from 'node:fs';
const E = await import(process.cwd() + '/packages/engine/dist/index.js');
const FT = 390144;
const d = JSON.parse(readFileSync('apps/worker/test/fixtures/courtyard-house.json', 'utf8'));
d.project = { ...d.project, name: 'Courtyard House — kitchen remodel' };
d.extensionsUsed.FS_renovation = '0.1.0';
const mark = (c, id, status) => { const el = d[c][id]; el.extensions = { ...(el.extensions ?? {}), FS_renovation: { status } }; };
// Demolish the pantry: its two walls, its pocket door and the room.
mark('walls', 'W17', 'demolish'); mark('walls', 'W18', 'demolish'); mark('openings', 'O14', 'demolish'); mark('rooms', 'R9', 'demolish');
// A new 4' wall from the old pantry corner, a free end at the island's side.
d.junctions.J90 = { level: 'L1', position: [50 * FT, 56 * FT] };
d.walls.W90 = { level: 'L1', start: 'J24', end: 'J90', type: d.walls.W17.type, name: 'Feature wall', extensions: { FS_renovation: { status: 'new' } } };
// A new window where the pantry was.
d.openings.O90 = { wall: 'W6', offset: Math.round(2.5 * FT), fill: 'window-casement-30x48', name: 'New kitchen window', extensions: { FS_renovation: { status: 'new' } } };
const fc = d.extensions.FS_furniture.collections;
const elements = {};
for (const id of ['KIT-E0', 'KIT-E1', 'KIT-E2', 'KIT-E3']) elements[id] = 'demolish';
elements['KIT-FRIDGE'] = 'demolish'; elements['KIT-ISLAND'] = 'demolish'; elements['KIT-COOKTOP'] = 'demolish';
const copy = (x) => JSON.parse(JSON.stringify(x));
const at = (src, host) => ({ ...copy(src), host });
const free = (x, y, rotation) => ({ mode: 'free', level: 'L1', position: [x, y], rotation });
fc.casework['KIT-ISLAND-N'] = { ...at(fc.casework['KIT-ISLAND'], { mode: 'surface', room: 'R8', surface: 'floor', position: [44 * FT, 52 * FT], rotation: 0 }), name: 'New island, 1800 mm' };
fc.appliances['KIT-COOKTOP-N'] = { ...at(fc.appliances['KIT-COOKTOP'], { mode: 'surface', room: 'R8', surface: 'floor', position: [44 * FT, 52 * FT], rotation: 0 }) };
fc.casework['KIT-N0'] = at(fc.casework['KIT-E0'], free(24066146, 22300000, 180000000));
fc.casework['KIT-N1'] = at(fc.casework['KIT-E0'], free(24066146, 23068000, 180000000));
fc.appliances['KIT-FRIDGE-N'] = at(fc.appliances['KIT-FRIDGE'], free(24066146, 24100000, 180000000));
// What stands on the pantry's walls or floor goes with them (FS_renovation 6.1.1): its outlets, switch and light.
const gone = new Set(['W17', 'W18', 'R9']);
for (const data of Object.values(d.extensions)) for (const coll of Object.values(data.collections ?? {})) for (const [id, el] of Object.entries(coll)) {
  const h = el.host ?? {};
  if (gone.has(h.wall) || gone.has(h.room)) elements[id] = 'demolish';
}
for (const id of ['KIT-ISLAND-N', 'KIT-COOKTOP-N', 'KIT-N0', 'KIT-N1', 'KIT-FRIDGE-N']) elements[id] = 'new';
d.extensions.FS_renovation = { elements };
const reader = { extensions: E.OFFICIAL_EXTENSION_NAMES, knownExtensions: E.OFFICIAL_EXTENSIONS };
const ev = E.evaluate(d, reader);
console.log('valid', ev.valid, JSON.stringify(ev.diagnostics.filter((x) => x.severity === 'error')));
if (!ev.valid) process.exit(1);
writeFileSync(process.argv[2], JSON.stringify(d, null, 2) + '\n');
