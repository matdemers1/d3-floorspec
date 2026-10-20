// A Vitest reporter for the unit groups in CI (FLR-T-12.47): after a package's run it prints its
// slowest tests against their own timeouts, and warns on any that took more than half of one — the
// headroom a test needs so a slower runner does not fail it. It never fails a run; the timeouts do.
//
// Passed on the command line, beside the default reporter:
//   pnpm turbo run test --filter=… -- --reporter=default --reporter="$PWD/.github/vitest-timeouts.mjs"
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SHOWN = Number(process.env.TIMEOUTS_SHOWN ?? 3);

export default class TimeoutHeadroomReporter {
  onTestRunEnd(testModules) {
    const rows = [];
    for (const module of testModules) {
      for (const test of module.children.allTests()) {
        const duration = test.diagnostic()?.duration;
        if (duration === undefined || test.result().state === 'skipped') continue;
        const timeout = test.options.timeout ?? test.project.config.testTimeout;
        rows.push({ duration, timeout, file: relative(process.cwd(), test.module.moduleId), name: test.fullName });
      }
    }
    rows.sort((a, b) => b.duration / b.timeout - a.duration / a.timeout || b.duration - a.duration);
    const dir = relative(process.env.GITHUB_WORKSPACE ?? process.cwd(), process.cwd());
    const { name } = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    const s = (ms) => `${(ms / 1000).toFixed(1)}s`;
    const pct = (r) => Math.round((100 * r.duration) / r.timeout);
    for (const r of rows.slice(0, SHOWN)) {
      console.log(`[timeouts] ${name} ${s(r.duration)} of ${s(r.timeout)} (${pct(r)}%) ${r.file} > ${r.name}`);
    }
    for (const r of rows.filter((x) => x.duration > x.timeout / 2)) {
      const where = process.env.GITHUB_ACTIONS ? `::warning file=${join(dir, r.file)},title=Over half its timeout::` : 'warning: over half its timeout: ';
      console.log(`${where}${s(r.duration)} of ${s(r.timeout)} — ${r.name}`);
    }
  }
}
