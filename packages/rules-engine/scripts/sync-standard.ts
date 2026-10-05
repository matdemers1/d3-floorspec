/**
 * Vendor the parts of the Floorspec standard the rules engine is tested against (FLR-ADR-009: "the
 * conformance suite is the oracle, pinned from ../floorspec") — the Rules counterpart of
 * packages/engine/scripts/sync-standard.ts and packages/ops/scripts/sync-standard.ts.
 *
 *   pnpm --filter @floorspec/rules-engine sync-standard [<floorspec checkout>] [--allow-dirty]
 *
 * Copies, from a floorspec checkout (default: ../floorspec beside this repository):
 *
 *   schema/rules/0.1/       → standard/schema/rules/0.1/       (request, pack, rule, profile, report, finding)
 *   conformance/rules/0.1/  → standard/conformance/rules/0.1/  (the 85 tests: reports and measure calls)
 *   spec/rules/             → standard/spec/rules/             (the text: the diagnostic catalogue,
 *                                                               the notice, the default profile and
 *                                                               the deferred measures are checked
 *                                                               against it)
 *
 * and records the checkout's commit in standard/LOCK.json. It refuses a checkout with uncommitted
 * changes in those paths unless --allow-dirty is given, in which case LOCK.json says so and CI's
 * pin check fails until a clean sync replaces it. Run `pnpm --filter @floorspec/rules-engine
 * generate` afterwards: the schemas feed the generated validators and types.
 *
 * The official extensions' schemas — whose member defaults the measures read (Rules 4.5) — are not
 * vendored here: they are the engine's (packages/engine/standard/registry), because the defaults
 * that apply are those of the extension versions the engine implements.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const PATHS = ['schema/rules/0.1', 'conformance/rules/0.1', 'spec/rules'] as const;

const here = dirname(new URL(import.meta.url).pathname);
const root = resolve(here, '..');
const standardDir = join(root, 'standard');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function main(argv: string[]): void {
  const allowDirty = argv.includes('--allow-dirty');
  const positional = argv.filter((a) => !a.startsWith('--'));
  const source = resolve(positional[0] ?? join(root, '..', '..', '..', 'floorspec'));
  if (!existsSync(join(source, 'spec', 'rules'))) {
    console.error(`sync-standard: ${source} is not a floorspec checkout with spec/rules`);
    process.exit(2);
  }
  const commit = git(source, 'rev-parse', 'HEAD');
  const status = git(source, 'status', '--porcelain', '--untracked-files=all', '--', ...PATHS);
  const dirty = status.length > 0;
  if (dirty && !allowDirty) {
    console.error(`sync-standard: ${source} has uncommitted changes in the vendored paths:\n${status}\n(use --allow-dirty to sync them anyway)`);
    process.exit(1);
  }

  rmSync(standardDir, { recursive: true, force: true });
  const copied: string[] = [];
  for (const p of PATHS) {
    const from = join(source, p);
    if (!existsSync(from)) {
      console.warn(`sync-standard: ${p} does not exist in the checkout yet; skipped`);
      continue;
    }
    const to = join(standardDir, p);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true });
    copied.push(p);
  }
  const lock = {
    $comment: 'Written by scripts/sync-standard.ts. CI checks out matdemers1/floorspec at `commit` and diffs `paths` against this directory.',
    repository: 'matdemers1/floorspec',
    commit,
    dirty,
    paths: copied,
  };
  mkdirSync(standardDir, { recursive: true });
  writeFileSync(join(standardDir, 'LOCK.json'), JSON.stringify(lock, null, 2) + '\n');
  console.log(`sync-standard: vendored ${copied.join(', ') || 'nothing'} from ${source} at ${commit}${dirty ? ' (DIRTY)' : ''}`);
}

main(process.argv.slice(2));
