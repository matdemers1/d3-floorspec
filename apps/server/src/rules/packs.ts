import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { assures, isPack, packText, profileOk, type Pack, type Profile } from '@floorspec/rules-engine';
import { deriveMatrix, EMPTY_MATRIX, isMatrix, mergeMatrices, publishedFor, type CoverageMatrix } from './coverage.js';

/**
 * The rule packs this instance has installed (FLR-T-6.2): built pack objects (Floorspec Rules 0.1,
 * chapter 2), as the standard's `pnpm packs` writes them to `rules/<pack>/generated/pack.json`,
 * read once at boot from `RULE_PACKS_DIR`. None is installed by default — and then findings say so
 * (NO_RULE_PACKS) rather than look clean.
 *
 * In the directory, each `*.json` file is one pack, and so is each `<name>/generated/pack.json` — so
 * the directory can be a folder of copied pack files, or the standard's own `rules/` folder (whose
 * `<name>/pack.json` manifests are not built packs, and are not read). A file that is not a pack —
 * not JSON, failing the Rules 0.1 pack schema, a duplicate name and version, or text that would
 * tell a reader a design meets a code (Rules 3.11, 9.8) — refuses the boot, naming the file: an
 * operator who installed a pack expects it to be checked, not silently skipped.
 *
 * The packs are evaluated under one jurisdiction profile (Rules chapter 10): the default profile
 * (10.6, the model codes' latest editions) unless `RULE_PROFILE` names a profile file, validated the
 * same way. A rule whose cited edition the profile does not put in force is not evaluated, and the
 * report says so (`notEvaluated`, reason `edition`). A project can choose its own profile
 * (FLR-T-6.8, `rule_profiles`); this one is the default for every project that has not.
 *
 * Each pack's coverage matrix (FLR-REQ-096) is read with it: the `coverage.json` the standard's
 * tooling publishes beside a built pack (`<name>/generated/coverage.json`), or `<file>.coverage.json`
 * beside a copied `<file>.json` — and, when neither is there, derived from the pack (coverage.ts).
 */

export interface InstalledPacks {
  readonly packs: readonly Pack[];
  /** Where each pack was read from, relative to the directory, in the same order. */
  readonly sources: readonly string[];
  /** The profile they are evaluated under; absent, the default profile (Rules 10.6). */
  readonly profile?: Profile;
  /** The packs' coverage matrix, merged (FLR-REQ-096). Absent: derived from `packs` when asked for. */
  readonly coverage?: CoverageMatrix;
  /** For each pack, in the same order: whether its matrix was published beside it, or derived here. */
  readonly coverageSources?: readonly ('published' | 'derived')[];
}

export class RulePackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RulePackError';
  }
}

export const NO_PACKS: InstalledPacks = Object.freeze({ packs: [], sources: [], coverage: EMPTY_MATRIX, coverageSources: [] });

/** The pack files under `dir`, sorted: its `*.json` files, then each `<name>/generated/pack.json`. */
function packFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    const stat = statSync(path);
    // `<file>.coverage.json` is a pack's matrix, not a pack.
    if (stat.isFile() && entry.endsWith('.json') && !entry.endsWith('.coverage.json')) out.push(path);
    else if (stat.isDirectory()) {
      const built = join(path, 'generated', 'pack.json');
      if (existsSync(built)) out.push(built);
    }
  }
  return out;
}

/** The coverage matrix published beside a pack file, if there is one and it is that pack's. */
function publishedMatrix(file: string, pack: Pack): CoverageMatrix | null {
  const beside = basename(file) === 'pack.json' && basename(dirname(file)) === 'generated' ? join(dirname(file), 'coverage.json') : file.replace(/\.json$/, '.coverage.json');
  if (!existsSync(beside)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(beside, 'utf8'));
  } catch {
    return null;
  }
  return isMatrix(value) ? publishedFor(pack, value) : null;
}

/** The merged matrix of every installed pack, published where it can be, derived where not. */
export function coverageOf(installed: InstalledPacks): CoverageMatrix {
  return installed.coverage ?? mergeMatrices(installed.packs.map(deriveMatrix));
}

/** Read and validate a profile file (Rules 10.1). */
export function loadProfile(file: string): Profile {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new RulePackError(`RULE_PROFILE ${file} is not a JSON file: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!profileOk(value)) throw new RulePackError(`RULE_PROFILE ${file} is not a Floorspec Rules 0.1 profile (schema/rules/0.1/profile.schema.json, 10.1)`);
  return value;
}

/** Read and validate every pack in `dir`, and the profile in `profileFile`. Undefined `dir`: none installed. */
export function loadRulePacks(dir: string | undefined, profileFile?: string): InstalledPacks {
  const profile = profileFile === undefined ? undefined : loadProfile(profileFile);
  if (dir === undefined) return profile === undefined ? NO_PACKS : { ...NO_PACKS, profile };
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new RulePackError(`RULE_PACKS_DIR ${dir} is not a directory`);
  const packs: Pack[] = [];
  const sources: string[] = [];
  const matrices: CoverageMatrix[] = [];
  const coverageSources: ('published' | 'derived')[] = [];
  const seen = new Map<string, string>();
  for (const file of packFiles(dir)) {
    const name = relative(dir, file);
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      throw new RulePackError(`rule pack ${name} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isPack(value)) throw new RulePackError(`rule pack ${name} is not a Floorspec Rules 0.1 pack (schema/rules/0.1/pack.schema.json)`);
    if (packText(value).some(assures)) throw new RulePackError(`rule pack ${name} says a design meets a code; findings are advice (Rules 3.11)`);
    const key = `${value.name}@${value.version}`;
    const earlier = seen.get(key);
    if (earlier !== undefined) throw new RulePackError(`rule packs ${earlier} and ${name} are both ${key}`);
    seen.set(key, name);
    packs.push(value);
    sources.push(name);
    const published = publishedMatrix(file, value);
    matrices.push(published ?? deriveMatrix(value));
    coverageSources.push(published === null ? 'derived' : 'published');
  }
  return { packs, sources, coverage: mergeMatrices(matrices), coverageSources, ...(profile === undefined ? {} : { profile }) };
}
