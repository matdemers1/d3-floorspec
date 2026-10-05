/**
 * Vendor the parts of the Floorspec standard the engine is tested against (FLR-ADR-009: "the
 * conformance suite is the oracle, pinned from ../floorspec").
 *
 *   pnpm --filter @floorspec/engine sync-standard [<floorspec checkout>] [--allow-dirty]
 *
 * Copies, from a floorspec checkout (default: ../floorspec beside this repository):
 *
 *   schema/core/0.1/            → standard/schema/core/0.1/
 *   schema/core/0.2/            → standard/schema/core/0.2/
 *   schema/registry/0.1/        → standard/schema/registry/0.1/   (registry entries, Core 0.2 12.2)
 *   conformance/core/0.1/       → standard/conformance/core/0.1/
 *   conformance/core/0.2/       → standard/conformance/core/0.2/
 *   spec/core/10-diagnostics.md → standard/spec/core/10-diagnostics.md
 *   registry/                   → standard/registry/              (the official extensions: entries, specs, schemas)
 *   conformance/ext/            → standard/conformance/ext/       (their suites)
 *
 * and records the checkout's commit in standard/LOCK.json. It refuses a checkout with uncommitted
 * changes in those paths unless --allow-dirty is given, in which case LOCK.json says so and CI's
 * pin check fails until a clean sync replaces it. Run `pnpm --filter @floorspec/engine generate`
 * afterwards: the schema feeds the generated types, validator and defaults table.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const PATHS = [
  'schema/core/0.1',
  'schema/core/0.2',
  'schema/registry/0.1',
  'conformance/core/0.1',
  'conformance/core/0.2',
  'spec/core/10-diagnostics.md',
  'registry',
  'conformance/ext',
] as const;

const here = dirname(new URL(import.meta.url).pathname);
const engineRoot = resolve(here, '..');
const standardDir = join(engineRoot, 'standard');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function main(argv: string[]): void {
  const allowDirty = argv.includes('--allow-dirty');
  const positional = argv.filter((a) => !a.startsWith('--'));
  const source = resolve(positional[0] ?? join(engineRoot, '..', '..', '..', 'floorspec'));
  if (!existsSync(join(source, 'spec', 'core'))) {
    console.error(`sync-standard: ${source} is not a floorspec checkout`);
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
  writeFileSync(join(standardDir, 'LOCK.json'), JSON.stringify(lock, null, 2) + '\n');
  console.log(`sync-standard: vendored ${copied.join(', ')} from ${source} at ${commit}${dirty ? ' (DIRTY)' : ''}`);
}

main(process.argv.slice(2));
