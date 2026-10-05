/**
 * How long evaluation takes: every synthetic pack of the Rules conformance suite (each pack name
 * made unique), under a profile adopting every edition the suite cites, over the largest document
 * of the suite — and, to see how it scales, over that document with its plan repeated side by side.
 *
 *   pnpm --filter @floorspec/rules-engine exec tsx scripts/perf.ts
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { OFFICIAL_EXTENSIONS, check } from '@floorspec/engine';
import { evaluate, isPack, type Pack } from '../src/index.js';

const SUITE = join(import.meta.dirname, '..', 'standard', 'conformance', 'rules', '0.1');
const dirs: string[] = [];
const walk = (d: string): void => {
  for (const e of readdirSync(d).sort()) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (e === 'test.json') dirs.push(d);
  }
};
walk(SUITE);

const packs: Pack[] = [];
const adopts = new Map<string, string>();
for (const d of dirs) {
  const rq = join(d, 'request.json');
  if (!existsSync(rq)) continue;
  let req: { packs?: unknown[] };
  try {
    req = JSON.parse(readFileSync(rq, 'utf8')) as { packs?: unknown[] };
  } catch {
    continue;
  }
  for (const p of req.packs ?? []) {
    if (!isPack(p)) continue;
    const name = `p${packs.length}`;
    packs.push({ ...p, name });
    for (const r of Object.values(p.rules)) if (r) adopts.set(r.citation.code, r.citation.edition);
  }
}
const profile = { floorspecRules: '0.1', name: 'Every edition the suite cites', adopts: [...adopts].map(([code, edition]) => ({ code, edition })) };
const largest = dirs.map((d) => join(d, 'input.json')).sort((a, b) => statSync(b).size - statSync(a).size)[0]!;
const doc = new Uint8Array(readFileSync(largest));
const options = { knownExtensions: OFFICIAL_EXTENSIONS };
const request = { floorspecRules: '0.1', packs, profile };

const time = (label: string, f: () => unknown, n = 20): void => {
  f(); // warm
  const t: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = performance.now();
    f();
    t.push(performance.now() - s);
  }
  t.sort((a, b) => a - b);
  console.log(`${label}: median ${t[Math.floor(n / 2)]!.toFixed(1)} ms, p90 ${t[Math.floor(n * 0.9)]!.toFixed(1)} ms`);
};

const r = evaluate(doc, request, options);
const rules = packs.reduce((s, p) => s + Object.keys(p.rules).length, 0);
console.log(`${packs.length} packs, ${rules} rules under one profile: ${r.evaluated.length} evaluated, ${r.findings.length} findings, over ${largest.slice(SUITE.length + 1)} (${statSync(largest).size} bytes)`);
time('validate + derive only (engine check)', () => check(doc, { extensions: ['FS_electrical', 'FS_plumbing', 'FS_mechanical', 'FS_lowvoltage'], ...options }));
time('evaluate: every synthetic pack, one profile', () => evaluate(doc, request, options));

// Every report test's own request (its packs and profile) over the largest document, in turn.
const requests = dirs.filter((d) => existsSync(join(d, 'request.json'))).map((d) => new Uint8Array(readFileSync(join(d, 'request.json'))));
let evaluated = 0;
for (const q of requests) evaluated += evaluate(doc, q, options).evaluated.length;
time(`evaluate: all ${requests.length} suite requests over it (${evaluated} rule evaluations)`, () => { requests.forEach((q) => evaluate(doc, q, options)); }, 10);

// Scale: the Phase 6 demo pack over a grid of n × n bedrooms, each with a window and a receptacle.
const demo = JSON.parse(readFileSync(join(SUITE, 'examples', '002-p6-demo-boiler-beside-panel-bedroom-without-window', 'request.json'), 'utf8')) as { packs: Pack[]; profile: unknown };
const reach: Pack = {
  ...demo.packs[0]!,
  name: 'reach',
  rules: {
    REACH: {
      title: 'Receptacle within reach along the wall',
      citation: { code: 'TEST-ELEC', edition: '2026', section: '§1' },
      paraphrase: 'Synthetic: no point along a room wall line is more than 6 ft from a receptacle. It states no requirement of any real code.',
      applies: { to: 'room' },
      requirement: { measure: 'receptacleReach', op: '<=', value: 6 * 390144 },
      severity: 'mayNotMeet',
      provenance: { verifiedBy: 'perf', verifiedOn: '2026-10-05', edition: '2026' },
    },
  },
  coverage: [],
};
for (const n of [5, 10, 20]) {
  const g = grid(n);
  const req = { floorspecRules: '0.1', packs: [demo.packs[0]!, reach], profile: demo.profile };
  const out = evaluate(g, req, options);
  time(`evaluate: demo pack + receptacle reach over ${n * n} rooms (${out.findings.length} findings)`, () => evaluate(g, req, options), 5);
}

function grid(n: number): Record<string, unknown> {
  const S = 12 * 390144;
  const junctions: Record<string, unknown> = {};
  const walls: Record<string, unknown> = {};
  const rooms: Record<string, unknown> = {};
  const openings: Record<string, unknown> = {};
  const receptacles: Record<string, unknown> = {};
  const J = (i: number, j: number): string => `J${i}_${j}`;
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) junctions[J(i, j)] = { level: 'L1', position: [i * S, j * S] };
  for (let i = 0; i <= n; i++)
    for (let j = 0; j <= n; j++) {
      if (i < n) walls[`H${i}_${j}`] = { level: 'L1', start: J(i, j), end: J(i + 1, j), type: 'WT' };
      if (j < n) walls[`V${i}_${j}`] = { level: 'L1', start: J(i, j), end: J(i, j + 1), type: 'WT' };
    }
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      rooms[`R${i}_${j}`] = { level: 'L1', anchor: [i * S + S / 2, j * S + S / 2], function: 'sleeping' };
      openings[`O${i}_${j}`] = { wall: `H${i}_${j}`, offset: 4 * 390144, fill: (i + j) % 2 ? 'WIN' : 'DOOR' };
      receptacles[`X${i}_${j}`] = { fallback: { level: 'L1', box: { min: [0, -51200, -76800], max: [32000, 51200, 76800] } }, host: { mode: 'wallFace', wall: `V${i}_${j}`, side: 'right', offset: 3 * 390144, height: 390144 } };
    }
  return {
    floorspec: '0.2',
    project: { name: 'grid' },
    buildings: { B1: {} },
    levels: { L1: { building: 'B1', elevation: 0, height: 3456000 } },
    types: {
      WT: { kind: 'wallType', layers: [{ thickness: 128000, function: 'core' }] },
      WIN: { kind: 'windowType', width: 3 * 390144, height: 4 * 390144, sill: 2 * 390144 },
      DOOR: { kind: 'doorType', width: 3 * 390144, height: 7 * 390144 },
    },
    junctions,
    walls,
    rooms,
    openings,
    extensionsUsed: { FS_electrical: '0.1.0' },
    extensions: { FS_electrical: { collections: { receptacles } } },
  };
}

const g20 = grid(20);
time('validate + derive only, 400 rooms (engine check)', () => check(g20, { extensions: ['FS_electrical', 'FS_plumbing', 'FS_mechanical', 'FS_lowvoltage'], ...options }), 5);
