/**
 * Render the sample programs' candidates so a person can look at them:
 *
 *   pnpm --filter @floorspec/layout-solver render [sample…] [--count N] [--all-levels] [--out DIR]
 *
 * Writes <out>/<sample>-<rank>-<level>.svg (and .png when rsvg-convert is on the PATH) for every
 * level a candidate lays out, and prints each candidate's score and explanation. out/, the
 * default, is gitignored.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from '@floorspec/ops';
import { renderPlan } from '@floorspec/render2d';
import { parseDocument } from '../src/document.js';
import { solve } from '../src/index.js';
import { SAMPLES } from '../test/programs.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const countAt = args.indexOf('--count');
const outAt = args.indexOf('--out');
const out = outAt >= 0 ? resolve(args[outAt + 1]!) : join(here, '..', 'out');
mkdirSync(out, { recursive: true });
const count = countAt >= 0 ? Number(args[countAt + 1]) : 3;
const allLevels = args.includes('--all-levels');
const names = args.filter((a, i) => !a.startsWith('--') && (countAt < 0 || i !== countAt + 1) && (outAt < 0 || i !== outAt + 1));
const chosen = (names.length > 0 ? names : Object.keys(SAMPLES)) as (keyof typeof SAMPLES)[];

let rsvg = true;
for (const name of chosen) {
  const doc = SAMPLES[name]();
  const started = performance.now();
  const candidates = solve(doc, { count, ignoreItemLevels: allLevels });
  console.log(`\n=== ${name}: ${String(candidates.length)} candidates in ${String(Math.round(performance.now() - started))} ms`);
  const base = parseDocument(doc);
  for (const c of candidates) {
    const r = apply(base, { batch: c.batch });
    if (r.status !== 'committed') throw new Error(`candidate ${c.id} does not commit`);
    for (const level of c.levels) {
      const svg = renderPlan(r.document, { level, scale: 16 });
      const file = join(out, `${name}-${String(c.rank)}-${level}`);
      writeFileSync(`${file}.svg`, svg);
      if (rsvg)
        try {
          execFileSync('rsvg-convert', ['-b', 'white', '-o', `${file}.png`, `${file}.svg`]);
        } catch {
          rsvg = false;
          console.log('(rsvg-convert not found: SVG only)');
        }
    }
    const s = c.score;
    console.log(`\n#${String(c.rank)} ${c.id}  total ${s.total.toFixed(1)}  brief ${s.briefFit.toFixed(3)}  circulation ${s.circulation.toFixed(3)}  findings ${s.findings.toFixed(3)}  (${String(c.batch.length)} ops)`);
    console.log(`   ${c.label}`);
    console.log(`   detail ${JSON.stringify(s.detail)}`);
    for (const line of c.explanation) console.log(`   - ${line}`);
    if (c.unplaced.length > 0) console.log(`   unplaced: ${c.unplaced.map((u) => `${u.item} x${String(u.count)} (${u.reason})`).join('; ')}`);
  }
}
