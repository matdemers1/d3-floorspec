import { findingsFor, NOTICE, type Units } from '@floorspec/rules-engine';
import type { Db } from '../db.js';
import { NO_RULE_PACKS } from '../routes/checks.js';
import { coverageOf, type InstalledPacks } from '../rules/packs.js';
import { defaultProfile, profileOfProject } from '../rules/profiles.js';

/**
 * The findings a share link shows (FLR-T-9.6): the same advisory report the owner's findings route
 * makes (FLR-ADR-011) — the installed packs against the shared version under the project's
 * jurisdiction profile, with the notice that they are not a plan review and what was and was not
 * checked — answered in the same shape, so the same components draw it. `coverageUrl` points at the
 * link's own coverage route, not at a screen that needs an account.
 */

function unitsOf(document: unknown): Units {
  const extras = (document as { extras?: { d3floorspec?: { units?: unknown } } } | null)?.extras;
  return extras?.d3floorspec?.units === 'metric' ? 'metric' : 'imperial';
}

export async function sharedFindings(db: Db, project: { ruleProfileId: string | null }, version: { hash: string; document: unknown }, rules: InstalledPacks): Promise<Record<string, unknown>> {
  const chosen = await profileOfProject(db, project, rules);
  // The profile's name and editions are the report's subject; the profile's ID is the owner's.
  const about = { profile: chosen.profile.name, profileId: null, notice: NOTICE, coverageUrl: 'coverage' };
  if (rules.packs.length === 0) return { head: 'main', hash: version.hash, findings: [], rulePacks: [], note: NO_RULE_PACKS, ...about };
  const report = findingsFor(version.document as object, chosen.profile, rules.packs, { units: unitsOf(version.document) });
  return {
    head: 'main',
    hash: version.hash,
    findings: report.findings,
    rulePacks: rules.packs.map((p) => ({ name: p.name, version: p.version, title: p.title })),
    note: report.notice,
    ...about,
    ...(report.profile === undefined ? {} : { profile: report.profile }),
    ...(report.units === undefined ? {} : { units: report.units }),
    diagnostics: report.diagnostics,
    evaluated: report.evaluated,
    notEvaluated: report.notEvaluated,
    coverage: report.coverage,
  };
}

/** The installed packs' coverage matrix (FLR-REQ-096), as `/api/rule-packs` answers it: nothing about any project. */
export function sharedCoverage(installed: InstalledPacks): Record<string, unknown> {
  return {
    notice: NOTICE,
    installed: installed.packs.length,
    packs: installed.packs.map((p, i) => ({
      name: p.name,
      version: p.version,
      title: p.title,
      license: p.license,
      ...(p.description === undefined ? {} : { description: p.description }),
      rules: Object.keys(p.rules).length,
      coverage: installed.coverageSources?.[i] ?? 'derived',
    })),
    matrix: coverageOf(installed),
    default: { name: defaultProfile(installed).profile.name, source: defaultProfile(installed).source },
  };
}
