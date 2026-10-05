/**
 * Vendor the parts of the Floorspec standard the applier is tested against (FLR-ADR-009: "the
 * conformance suite is the oracle, pinned from ../floorspec") — the Ops counterpart of
 * packages/engine/scripts/sync-standard.ts.
 *
 *   pnpm --filter @floorspec/ops sync-standard [<floorspec checkout>] [--allow-dirty]
 *
 * Copies, from a floorspec checkout (default: ../floorspec beside this repository):
 *
 *   schema/ops/0.1/, 0.2/, 0.3/      → standard/schema/ops/0.1/, 0.2/, 0.3/
 *   conformance/ops/0.1/, 0.2/, 0.3/ → standard/conformance/ops/0.1/, 0.2/, 0.3/
 *   spec/ops/07-diagnostics.md       → standard/spec/ops/07-diagnostics.md
 *
 * Ops 0.3 has a request schema of its own since roofs and stairs: addElement accepts the
 * `roofs` and `stairs` collections, which Ops 0.2's request schema does not name.
 *
 * and records the checkout's commit in standard/LOCK.json. It refuses a checkout with uncommitted
 * changes in those paths unless --allow-dirty is given, in which case LOCK.json says so and CI's
 * pin check fails until a clean sync replaces it.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const PATHS = [
  'schema/ops/0.1',
  'schema/ops/0.2',
  'schema/ops/0.3',
  'conformance/ops/0.1',
  'conformance/ops/0.2',
  'conformance/ops/0.3',
  'spec/ops/07-diagnostics.md',
] as const;

const here = dirname(new URL(import.meta.url).pathname);
const opsRoot = resolve(here, '..');
const standardDir = join(opsRoot, 'standard');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function main(argv: string[]): void {
  const allowDirty = argv.includes('--allow-dirty');
  const positional = argv.filter((a) => !a.startsWith('--'));
  const source = resolve(positional[0] ?? join(opsRoot, '..', '..', '..', 'floorspec'));
  if (!existsSync(join(source, 'spec', 'ops'))) {
    console.error(`sync-standard: ${source} is not a floorspec checkout with spec/ops`);
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
