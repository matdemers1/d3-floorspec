// FLR-T-15.2: writes courtyard-house-outdoor.json — the Courtyard House on its lot (courtyard-house-on-its-lot.json,
// FLR-T-15.1) with its outdoor rooms (FS_outdoor 0.1.0, the board's "15.2 · The back terrace in 3D"): a cedar pergola
// over the back terrace, 15' 6" x 20' 4" and clear to 9', on 6x6 posts at most 8' apart; a heated plunge pool south
// of the terrace, 8' x 14' and 5' 6" deep, its 12" travertine coping flush with a pool surround graded to the floor's
// height (an FS_site pad); an outdoor kitchen along the terrace's north edge, a 12' run of grill, sink and
// refrigerator facing the terrace; and a gas fire pit east of it. Nothing else changes. Run from the repository root
// after building the engine:
//   node apps/worker/test/fixtures/make/courtyard-outdoor.mjs apps/worker/test/fixtures/courtyard-house-outdoor.json
import { readFileSync, writeFileSync } from 'node:fs';
const E = await import(process.cwd() + '/packages/engine/dist/index.js');
const FT = 390144;
const IN = 32512;
const ft = (v) => Math.round(v * FT);
const d = JSON.parse(readFileSync('apps/worker/test/fixtures/courtyard-house-on-its-lot.json', 'utf8'));
d.project = { ...d.project, name: 'Courtyard House — the back terrace' };
const lib = JSON.parse(readFileSync('packages/engine/standard/registry/FS_outdoor/library.json', 'utf8')).items;
const centred = (x, y, z0, z1) => ({ min: [-Math.floor(x / 2), -Math.floor(y / 2), z0], max: [x - Math.floor(x / 2), y - Math.floor(y / 2), z1] });
const free = (x, y, rotation) => ({ mode: 'free', level: 'L1', position: [ft(x), ft(y)], ...(rotation ? { rotation } : {}) });

// The back terrace SL2: 62' 6" to 78' east, 23' to 43' north; its middle at (70' 3", 33').
const terrace = d.slabs.SL2;
const xs = terrace.boundary.map((p) => p[0]);
const ys = terrace.boundary.map((p) => p[1]);
const [cx, cy] = [(Math.min(...xs) + Math.max(...xs)) / 2 / FT, (Math.min(...ys) + Math.max(...ys)) / 2 / FT];

const plunge = structuredClone(lib['plunge-pool-8x14'].element);
const pergola = structuredClone(lib['pergola-12x16'].element);
const kitchen = structuredClone(lib['kitchen-10'].element);
const pit = structuredClone(lib['fire-pit-4'].element);

d.extensionsUsed.FS_outdoor = '0.1.0';
d.extensions.FS_outdoor = {
  collections: {
    pools: {
      OX1: { ...plunge, name: 'Plunge pool', host: free(69, 15), fallback: { level: 'L1', box: plunge.fallback.box } },
    },
    shelters: {
      OX2: {
        ...pergola,
        name: 'Pergola',
        catalogue: 'pergola-12x16',
        clearHeight: 108 * IN,
        host: free(cx, cy),
        fallback: { level: 'L1', box: centred(ft(15.5), ft(20 + 4 / 12), 0, 126 * IN) },
      },
    },
    kitchens: {
      // facing south, onto the terrace: its run along the terrace's north edge
      OX3: { ...kitchen, name: 'Outdoor kitchen', host: free(cx, 45.25, -90000000), fallback: { level: 'L1', box: centred(30 * IN, ft(12), 0, 36 * IN) } },
    },
    fires: {
      OX4: { ...pit, name: 'Fire pit', host: free(83, 33), fallback: { level: 'L1', box: pit.fallback.box } },
    },
  },
};
// The pool's surround: the ground graded flush with its coping's top, a foot and a half round it (FS_site 4.1).
const [px0, px1, py0, py1] = [69 - 4 - 1.5, 69 + 4 + 1.5, 15 - 7 - 1.5, 15 + 7 + 1.5];
d.extensions.FS_site.pads.PAD2 = { name: 'Pool surround', elevation: 0, boundary: [[ft(px0), ft(py0)], [ft(px1), ft(py0)], [ft(px1), ft(py1)], [ft(px0), ft(py1)]] };

const reader = { extensions: E.OFFICIAL_EXTENSION_NAMES, knownExtensions: E.OFFICIAL_EXTENSIONS };
const r = E.check(d, reader);
if (!r.valid) throw new Error('not valid: ' + JSON.stringify(r.diagnostics.filter((x) => x.severity === 'error')));
const x = r.derived.extensions.FS_outdoor;
const gal = (v) => Math.round(Number(BigInt(v) / 1280n ** 3n) / 1e6 / 3.785411784);
console.log(`pool ${JSON.stringify(x.pools.OX1.basin.map((v) => v / FT))} ft basin, ${gal(x.pools.OX1.volume)} gal; pergola ${x.shelters.OX2.posts} posts, ${JSON.stringify(x.shelters.OX2.spacing.map((v) => (v / IN).toFixed(1)))}" o.c.`);
console.log(r.diagnostics.filter((x) => x.code.startsWith('FS-OUTD') || x.code.startsWith('FS-SITE')).map((x) => `${x.code} ${x.elements.join(',')}`).join('\n'));
writeFileSync(process.argv[2], JSON.stringify(d, null, 2) + '\n');
