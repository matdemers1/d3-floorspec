// FLR-T-15.1: writes courtyard-house-on-its-lot.json — a copy of courtyard-house.json set on an invented, gently
// sloping Georgia lot (FS_site): lot 14, Laurel Ridge Drive, about 120' x 148' (0.41 ac), falling about 8' to the
// street on the west, where the driveway and the front walk meet it. Its survey is fourteen spot elevations and six
// contour lines in a datum that puts the first floor at 814' 6"; its setbacks are 30' at the front, 10' at the
// sides and 25' at the rear; a pad under the house is fitted to the walls' outside faces 8" below the floor; the
// front walk steps down with the ground in three slabs. Nothing about the house itself changes: the ground moves,
// the house doesn't. Run from the repository root after building the engine and render2d:
//   node apps/worker/test/fixtures/make/courtyard-on-its-lot.mjs apps/worker/test/fixtures/courtyard-house-on-its-lot.json
import { readFileSync, writeFileSync } from 'node:fs';
const E = await import(process.cwd() + '/packages/engine/dist/index.js');
const R = await import(process.cwd() + '/packages/render2d/dist/index.js');
const FT = 390144;
const IN = 32512;
const ft = (v) => Math.round(v * FT);
const d = JSON.parse(readFileSync('apps/worker/test/fixtures/courtyard-house.json', 'utf8'));
d.project = { ...d.project, name: 'Courtyard House — on its lot' };

// The lot, counter-clockwise from its street edge (edge 0, the west side, on Laurel Ridge Drive).
const LOT = [[-34.5, 92], [-33.5, -27], [114.5, -30], [113, 93.5]];
d.site = { ...d.site, boundary: LOT.map(([x, y]) => [ft(x), ft(y)]) };

// The ground in the survey's feet: a bank down to the street, then a gentle rise past the house to the back.
const PROFILE = [[-34, 809.4], [0, 813.0], [31, 814.0], [62, 815.4], [114, 817.1]];
const along = (x) => {
  for (let i = 0; i + 1 < PROFILE.length; i++) {
    const [x0, h0] = PROFILE[i];
    const [x1, h1] = PROFILE[i + 1];
    if (x <= x1 || i + 2 === PROFILE.length) return h0 + ((h1 - h0) * (x - x0)) / (x1 - x0);
  }
  return PROFILE[0][1];
};
// a shallow swale toward the south side
const ground = (x, y) => along(x) - 0.3 * ((y - 33) / 60) ** 2;
const q = (v) => Math.round(v * 20) / 20;
const BENCH = 814.5;
const spots = {};
const SPOTS = [...LOT.map(([x, y], i) => [x, y, ['NW', 'SW', 'SE', 'NE'][i] + ' corner pin'])];
SPOTS.push(
  [-26, 28, 'Curb at the walk'], [-12, -10, 'Top of bank'], [-12, 78, null], [20, -18, null], [20, 82, null], [45, -12, null],
  [45, 80, null], [80, 10, null], [80, 70, null], [100, 32, null]);
SPOTS.forEach(([x, y, name], i) => {
  spots[`SP${i + 1}`] = { at: [ft(x), ft(y)], elevation: ft(q(ground(x, y)) - BENCH), ...(name ? { name } : {}) };
});
const contours = {};
[811, 812, 813, 815, 816, 817].forEach((h, i) => {
  const points = [];
  for (const y of [-26, 0, 33, 66, 90]) {
    let lo = -33;
    let hi = 112;
    if (!(ground(lo, y) <= h && h <= ground(hi, y))) continue;
    for (let k = 0; k < 60; k++) {
      const m = (lo + hi) / 2;
      if (ground(m, y) < h) lo = m;
      else hi = m;
    }
    points.push([ft(Math.round(lo * 2) / 2), ft(y)]);
  }
  if (points.length >= 2) contours[`CT${i + 1}`] = { elevation: ft(h - BENCH), points, name: `${h}'` };
});

// The front walk, stepping down with the ground: three slabs, 6" apart.
const walk = d.slabs.SL4;
const [wy0, wy1] = [Math.min(...walk.boundary.map((p) => p[1])), Math.max(...walk.boundary.map((p) => p[1]))];
const piece = (x0, x1, offset, name) => ({ ...walk, boundary: [[ft(x0), wy0], [ft(x1), wy0], [ft(x1), wy1], [ft(x0), wy1]], offset, name });
d.slabs.SL4 = piece(-9, 1, walk.offset, 'Front walk, top');
d.slabs.SL4B = piece(-19, -9, walk.offset - 6 * IN, 'Front walk, middle');
d.slabs.SL4C = piece(-30, -19, walk.offset - 12 * IN, 'Front walk, bottom');

// The house's pad: the outside faces of the main floor's walls, 8" below the floor.
const reader = { extensions: E.OFFICIAL_EXTENSION_NAMES, knownExtensions: E.OFFICIAL_EXTENSIONS };
const ev = E.evaluate(d, reader);
if (!ev.valid) throw new Error('the house is not valid: ' + JSON.stringify(ev.diagnostics.slice(0, 3)));
const scene = R.sceneOf(ev, 'L1');
const loops = R.outerBoundary(R.annoSourceOf(scene));
const outline = loops.sort((a, b) => b.length - a.length)[0].map(([x, y]) => [Math.round(x), Math.round(y)]);

d.extensionsUsed.FS_site = '0.1.0';
d.extensions.FS_site = {
  benchmark: ft(BENCH),
  spots,
  contours,
  setbacks: { street: [0], front: ft(30), side: ft(10), rear: ft(25) },
  pads: { PAD1: { name: 'House', elevation: -8 * IN, boundary: outline } },
};
const r = E.check(d, reader);
if (!r.valid) throw new Error('not valid: ' + JSON.stringify(r.diagnostics.filter((x) => x.severity === 'error')));
const x = r.derived.extensions.FS_site;
const yd3 = (v) => (Number(BigInt(v) / 10n ** 12n) / (1170432 ** 3 / 1e12)).toFixed(1);
console.log(`lot ${(Number(x.lot.area) / FT / FT).toFixed(0)} ft2; surface ${x.surface.points.length} points, ${x.surface.triangles.length} triangles; cut ${yd3(x.cut)} yd3, fill ${yd3(x.fill)} yd3`);
console.log(r.diagnostics.filter((x) => x.code.startsWith('FS-SITE')).map((x) => `${x.code} ${x.elements.join(',')}`).join('\n'));
writeFileSync(process.argv[2], JSON.stringify(d, null, 2) + '\n');
