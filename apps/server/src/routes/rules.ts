import { z } from 'zod';
import { editionsLine, NOTICE, normalizeProfile, profileProblems, serializeProfile, type Profile } from '@floorspec/rules-engine';
import type { Db, Tx } from '../db.js';
import { Prisma } from '../db.js';
import { Routes, type MutationResult } from '../http/routes.js';
import { HttpError } from '../http/errors.js';
import type { ProjectEvent } from '../events/types.js';
import { coverageOf, NO_PACKS, type InstalledPacks } from '../rules/packs.js';
import { defaultProfile, profileOfProject } from '../rules/profiles.js';
import { accountOf, parse } from './auth.js';

/**
 * Code rules, the parts a person sets up (FLR-T-6.8, FLR-T-6.9):
 *
 *   - **Jurisdiction profiles** (`/api/profiles`): the profiles an account builds — editions,
 *     effective dates, `asOf`, cited local amendments that withdraw rules (Rules chapter 10) — each
 *     the standard's own JSON object, checked field by field by @floorspec/rules-engine and stored
 *     in canonical form. Every one belongs to its account; another account's is a 404, as a project is.
 *   - **A project's profile** (`/api/projects/:id/profile`): which one its findings are evaluated
 *     under, or the instance default. Choosing one, editing it or deleting it tells the project's
 *     live stream (`profile`), so every screen showing findings fetches them again (10.7).
 *   - **Rule packs** (`/api/rule-packs`): the installed packs and their coverage matrix
 *     (FLR-REQ-096) — what is checked, what is not, who verified each rule and when.
 */

/** Generous, and finite: a profile is a person's data, typed into a form. */
const LIMITS = { adopts: 100, packs: 50, amendments: 200, withdraws: 200 };

const ProfileBody = z.strictObject({ profile: z.unknown() });
const ChooseBody = z.strictObject({ profileId: z.uuid().nullable() });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A profile from a request body, checked field by field (Rules 10.1), in canonical form. */
function profileFrom(body: unknown): Profile {
  const { profile } = parse(ProfileBody, body);
  const problems = profileProblems(profile);
  const p = profile as Partial<Profile> | null;
  if (problems.length === 0 && p !== null) {
    if ((p.adopts?.length ?? 0) > LIMITS.adopts) problems.push({ path: 'adopts', message: `a profile adopts at most ${String(LIMITS.adopts)} editions` });
    if ((p.packs?.length ?? 0) > LIMITS.packs) problems.push({ path: 'packs', message: `a profile selects at most ${String(LIMITS.packs)} packs` });
    if ((p.amendments?.length ?? 0) > LIMITS.amendments) problems.push({ path: 'amendments', message: `a profile has at most ${String(LIMITS.amendments)} amendments` });
    (p.amendments ?? []).forEach((m, i) => {
      if (m.withdraws.length > LIMITS.withdraws) problems.push({ path: `amendments/${String(i)}/withdraws`, message: `an amendment withdraws at most ${String(LIMITS.withdraws)} rules` });
    });
  }
  if (problems.length > 0) {
    throw new HttpError(400, 'this is not a jurisdiction profile that can be saved', {
      fields: problems.map((x) => ({ path: x.path === '' ? 'profile' : `profile.${x.path.replaceAll('/', '.')}`, message: x.message })),
    });
  }
  return normalizeProfile(profile as Profile);
}

/** What the audit trail keeps of a profile: its name, editions, and the whole of it as its file. */
const auditOf = (profile: Profile) => ({ name: profile.name, editions: editionsLine(profile), amendments: profile.amendments?.length ?? 0, file: serializeProfile(profile) });

async function usersOf(db: Db | Tx, profileId: string) {
  return db.project.findMany({ where: { ruleProfileId: profileId, deletedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
}

function profileEvents(projects: readonly { id: string }[], id: string | null, name: string, change: 'chosen' | 'edited' | 'deleted'): ProjectEvent[] {
  return projects.map((p) => ({ projectId: p.id, type: 'profile', data: { id, name, change } }));
}

export function profileRoutes(db: Db, installed: InstalledPacks = NO_PACKS): Routes {
  const routes = new Routes(db);

  /** An account's profiles, with the projects each is used by, and the instance default. */
  routes.read('/', async (req, res) => {
    const rows = await db.ruleProfile.findMany({
      where: { ownerAccountId: accountOf(req) },
      orderBy: { createdAt: 'asc' },
      include: { projects: { where: { deletedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } } },
    });
    const fallback = defaultProfile(installed);
    const usingDefault = await db.project.findMany({ where: { ownerAccountId: accountOf(req), deletedAt: null, ruleProfileId: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
    res.json({
      default: { id: null, profile: fallback.profile, source: fallback.source, projects: usingDefault },
      profiles: rows.map((r) => ({ id: r.id, profile: r.profile, createdAt: r.createdAt, updatedAt: r.updatedAt, projects: r.projects })),
      notice: NOTICE,
    });
  });

  routes.read('/:profileId', async (req, res) => {
    const row = await owned(db, req.params['profileId'], accountOf(req));
    res.json({ id: row.id, profile: row.profile, createdAt: row.createdAt, updatedAt: row.updatedAt, projects: await usersOf(db, row.id) });
  });

  routes.mutate('POST', '/', async (req, tx): Promise<MutationResult> => {
    const profile = profileFrom(req.body);
    const row = await tx.ruleProfile.create({ data: { ownerAccountId: accountOf(req), profile: profile as unknown as Prisma.InputJsonObject } });
    return {
      reply: (res) => res.status(201).json({ id: row.id, profile, createdAt: row.createdAt, updatedAt: row.updatedAt, projects: [] }),
      audit: { action: 'profile.create', targetType: 'rule_profile', targetId: row.id, detail: auditOf(profile) },
    };
  });

  routes.mutate('PUT', '/:profileId', async (req, tx): Promise<MutationResult> => {
    const before = await owned(tx, req.params['profileId'], accountOf(req));
    const profile = profileFrom(req.body);
    const row = await tx.ruleProfile.update({ where: { id: before.id }, data: { profile: profile as unknown as Prisma.InputJsonObject } });
    const projects = await usersOf(tx, row.id);
    return {
      reply: (res) => res.json({ id: row.id, profile, createdAt: row.createdAt, updatedAt: row.updatedAt, projects }),
      audit: { action: 'profile.update', targetType: 'rule_profile', targetId: row.id, detail: { ...auditOf(profile), before: serializeProfile(before.profile as unknown as Profile) } },
      events: profileEvents(projects, row.id, profile.name, 'edited'),
    };
  });

  /** A deleted profile is gone; the projects that used it go back to the default (the FK sets null). */
  routes.mutate('DELETE', '/:profileId', async (req, tx): Promise<MutationResult> => {
    const row = await owned(tx, req.params['profileId'], accountOf(req));
    const projects = await usersOf(tx, row.id);
    await tx.ruleProfile.delete({ where: { id: row.id } });
    const fallback = defaultProfile(installed).profile;
    return {
      reply: (res) => res.status(204).end(),
      audit: { action: 'profile.delete', targetType: 'rule_profile', targetId: row.id, detail: { ...auditOf(row.profile as unknown as Profile), projects: projects.map((p) => p.id) } },
      events: profileEvents(projects, null, fallback.name, 'deleted'),
    };
  });

  return routes;
}

/** The caller's own profile, or 404 — another account's profile and no profile are the same answer. */
async function owned(db: Db | Tx, id: unknown, accountId: string) {
  if (typeof id !== 'string' || !UUID.test(id)) throw new HttpError(404, 'profile not found');
  const row = await db.ruleProfile.findFirst({ where: { id, ownerAccountId: accountId } });
  if (row === null) throw new HttpError(404, 'profile not found');
  return row;
}

/** A project's profile: read it (a token may), and choose it (a person, in a session). */
export function projectProfileRoutes(db: Db, installed: InstalledPacks = NO_PACKS): Routes {
  const routes = new Routes(db);

  routes.read(
    '/:projectId/profile',
    async (req, res) => {
      const project = req.project;
      if (project === undefined) throw new HttpError(404, 'project not found');
      const chosen = await profileOfProject(db, project, installed);
      res.json({ id: chosen.id, profile: chosen.profile, default: chosen.id === null, defaultSource: defaultProfile(installed).source });
    },
    { token: 'read' },
  );

  routes.mutate('PUT', '/:projectId/profile', async (req, tx): Promise<MutationResult> => {
    const project = req.project;
    if (project === undefined) throw new HttpError(404, 'project not found');
    const { profileId } = parse(ChooseBody, req.body ?? {});
    let profile: Profile;
    if (profileId === null) profile = defaultProfile(installed).profile;
    else {
      const row = await tx.ruleProfile.findFirst({ where: { id: profileId, ownerAccountId: project.ownerAccountId } });
      // Somebody else's profile is not one to choose, and says no more than a missing one.
      if (row === null) throw new HttpError(400, 'the request body is not valid', { fields: [{ path: 'profileId', message: 'no such profile' }] });
      profile = row.profile as unknown as Profile;
    }
    await tx.project.update({ where: { id: project.id }, data: { ruleProfileId: profileId } });
    return {
      reply: (res) => res.json({ id: profileId, profile, default: profileId === null, defaultSource: defaultProfile(installed).source }),
      audit: { action: 'project.profile', targetType: 'project', targetId: project.id, detail: { profile: profileId, name: profile.name, editions: editionsLine(profile), previous: project.ruleProfileId } },
      events: profileEvents([project], profileId, profile.name, 'chosen'),
    };
  });

  return routes;
}

/**
 * The installed rule packs and their coverage matrix (FLR-REQ-096). Nothing to do with a project,
 * so any signed-in account may read it; with no pack installed, an empty matrix and a note that
 * says nothing was checked.
 */
export function rulePackRoutes(db: Db, installed: InstalledPacks = NO_PACKS): Routes {
  const routes = new Routes(db);
  routes.read(
    '/',
    (_req, res) => {
      const coverage = coverageOf(installed);
      res.json({
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
        matrix: coverage,
        default: { name: defaultProfile(installed).profile.name, source: defaultProfile(installed).source },
      });
    },
    { token: 'read' },
  );
  return routes;
}
