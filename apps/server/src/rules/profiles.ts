import { DEFAULT_PROFILE, normalizeProfile, type Profile } from '@floorspec/rules-engine';
import type { Db, Tx } from '../db.js';
import type { InstalledPacks } from './packs.js';

/**
 * Which jurisdiction profile a project's findings are evaluated under (FLR-T-6.8, Rules ch. 10).
 *
 * A project names one of its owner's profiles (`projects.rule_profile_id`), or none — and then the
 * instance default: the profile file RULE_PROFILE names, or else the standard's default profile,
 * "Model Codes (latest)" (Rules 10.6, FLR-REQ-099). Changing it is all it takes to re-evaluate the
 * project for another jurisdiction or code cycle (10.7): nothing about an earlier evaluation is
 * kept.
 */

export interface ChosenProfile {
  /** The stored profile's ID; null for the instance default. */
  readonly id: string | null;
  readonly profile: Profile;
}

/** Where the default comes from: the standard's 10.6, or the operator's RULE_PROFILE file. */
export type DefaultSource = 'standard' | 'instance';

export function defaultProfile(installed: InstalledPacks): { profile: Profile; source: DefaultSource } {
  return installed.profile === undefined
    ? { profile: normalizeProfile(DEFAULT_PROFILE), source: 'standard' }
    : { profile: installed.profile, source: 'instance' };
}

/** The profile a project is evaluated under now. */
export async function profileOfProject(db: Db | Tx, project: { ruleProfileId: string | null }, installed: InstalledPacks): Promise<ChosenProfile> {
  if (project.ruleProfileId !== null) {
    const row = await db.ruleProfile.findUnique({ where: { id: project.ruleProfileId } });
    if (row !== null) return { id: row.id, profile: row.profile as unknown as Profile };
  }
  return { id: null, profile: defaultProfile(installed).profile };
}
