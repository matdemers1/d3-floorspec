/**
 * Vendor the part of the Floorspec standard the migrator is tested against (FLR-ADR-009: "the
 * conformance suite is the oracle, pinned from ../floorspec") — the migration counterpart of
 * packages/engine/scripts/sync-standard.ts.
 *
 *   pnpm --filter @floorspec/migrate sync-standard [<floorspec checkout>] [--allow-dirty]
 *
 * Copies, from a floorspec checkout (default: ../floorspec beside this repository):
 *
 *   conformance/migration/0.3/  → standard/conformance/migration/0.3/
 *   conformance/migration/0.4/  → standard/conformance/migration/0.4/
 *   spec/core/20-migration.md   → standard/spec/core/20-migration.md
 *
 * and records the checkout's commit in standard/LOCK.json. It refuses a checkout with uncommitted
 * changes in those paths unless --allow-dirty is given, in which case LOCK.json says so and CI's
 * pin check fails until a clean sync replaces it. The property test reads the earlier drafts'
 * documents from the engine's vendored Core suites (packages/engine/standard).
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const PATHS = ['conformance/migration/0.3', 'conformance/migration/0.4', 'spec/core/20-migration.md'] as const;

const here = dirname(new URL(import.meta.url).pathname);
const packageRoot = resolve(here, '..');
const standardDir = join(packageRoot, 'standard');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function main(argv: string[]): void {
  const allowDirty = argv.includes('--allow-dirty');
  const positional = argv.filter((a) => !a.startsWith('--'));
  const source = resolve(positional[0] ?? join(packageRoot, '..', '..', '..', 'floorspec'));
  if (!existsSync(join(source, 'spec', 'core', '20-migration.md'))) {
    console.error(`sync-standard: ${source} is not a floorspec checkout with spec/core/20-migration.md`);
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
