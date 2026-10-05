import { z } from 'zod';
import { parseLength } from '@floorspec/ops';
import { solve, SolverError, toChangesetProposals, type Candidate } from '@floorspec/layout-solver';
import type { Db, Tx } from '../db.js';
import type { Changeset } from '../generated/prisma/client.js';
import { Routes, type MutationResult } from '../http/routes.js';
import { HttpError } from '../http/errors.js';
import { ProblemError } from '../http/problem.js';
import type { Applier, Batch } from '../ops/applier.js';
import { MAIN } from '../domain/projects.js';
import { applyToHead, authorOf, changesetHead, lockProject, readHead, retiredFor } from '../domain/history.js';
import { changesetView, MAX_CHANGESET_NAME, openChangeset } from '../domain/changesets.js';
import { changesetEvent, countChangesetOps } from '../events/publish.js';
import type { ProjectEvent } from '../events/types.js';
import { committedView, rejection } from './history.js';
import { parse } from './auth.js';

/** A length: an integer in base units, or the reference grammar ("72'", "21.9 m"). */
const Length = z.union([z.int().min(1).max(Number.MAX_SAFE_INTEGER), z.string().trim().min(1).max(64)]);

export const LayoutsBody = z.strictObject({
  /** An existing, empty level to lay out on. Default: the solver's choice (a new level if none is empty). */
  level: z.string().trim().min(1).max(64).optional(),
  /** The footprint to fit: width (east–west) and depth (north–south). Default: sized from the brief. */
  footprint: z.strictObject({ width: Length, depth: Length }).optional(),
  /** How many candidates. The solver gives at least three whenever the brief allows. */
  count: z.int().min(3).max(6).optional(),
});

function baseUnits(value: number | string, field: string): number {
  if (typeof value === 'number') return value;
  const parsed = parseLength(value);
  if (!parsed.ok || parsed.value <= 0n || parsed.value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HttpError(400, 'the request body is not valid', { fields: [{ path: `footprint.${field}`, message: parsed.ok ? 'a footprint is longer than zero' : parsed.reason }] });
  }
  return Number(parsed.value);
}

/** A name for a candidate's changeset that no pending changeset of the project has. */
function freeName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) {
    const suffix = ` (${String(n)})`;
    const stem = name.length + suffix.length > MAX_CHANGESET_NAME ? `${name.slice(0, MAX_CHANGESET_NAME - suffix.length - 1).trimEnd()}…` : name;
    if (!taken.has(`${stem}${suffix}`)) return `${stem}${suffix}`;
  }
}

/**
 * A pending changeset that already holds this candidate: the same name — rank, score and layout —
 * against the same main, one batch long. Solving again names it rather than opening a copy. (Its
 * IDs differ from a fresh solve's: the first solve retired the ones it minted.)
 */
async function sameCandidate(tx: Tx, projectId: string, changeset: Changeset, main: string, length: number): Promise<boolean> {
  if (changeset.baseHash !== main) return false;
  const ops = await tx.opLog.findMany({ where: { projectId, head: changesetHead(changeset.id) }, select: { ops: true } });
  return ops.length === 1 && Array.isArray(ops[0]?.ops) && ops[0].ops.length === length;
}

/** What the answer says of a candidate besides its changeset: the solver's report, for the candidates screen. */
function report(c: Candidate) {
  return {
    rank: c.rank,
    label: c.label,
    strategy: c.strategy,
    level: c.level,
    footprint: c.footprint,
    score: c.score,
    explanation: c.explanation,
    rooms: c.rooms.map((r) => ({ id: r.id, name: r.name, function: r.function, ...(r.item === undefined ? {} : { item: r.item }), area: r.area })),
    unplaced: c.unplaced,
    ops: c.batch.length,
  };
}

/**
 * Layout candidates (FLR-T-4.3, FLR-REQ-074, FLR-REQ-075): run the non-normative solver
 * (`@floorspec/layout-solver`) on main's program and open one pending changeset per ranked
 * candidate. Nothing is written to main — opening a candidate never overwrites the model; a person
 * accepts one (FLR-ADR-016). Accepting one makes the others stop applying: their walls would land
 * where the accepted one's are.
 *
 * An agent token may call it (scope `propose`): what it makes are changesets, as `POST /changesets`.
 */
export function layoutRoutes(db: Db, applier: Applier): Routes {
  const routes = new Routes(db);

  routes.mutate(
    'POST',
    '/:projectId/layouts',
    async (req, tx): Promise<MutationResult> => {
      const project = req.project;
      if (project === undefined) throw new HttpError(404, 'project not found');
      const body = parse(LayoutsBody, req.body ?? {});
      const footprint = body.footprint === undefined ? undefined : { width: baseUnits(body.footprint.width, 'width'), depth: baseUnits(body.footprint.depth, 'depth') };
      const author = authorOf(req);

      await lockProject(tx, project.id);
      const main = await readHead(tx, project.id, MAIN);
      const retired = await retiredFor(tx, project.id);
      let candidates: Candidate[];
      try {
        candidates = solve(main.document as object, {
          count: body.count ?? 3,
          retired,
          // Every candidate becomes a changeset of this project, so no two may name one ID.
          distinctIds: true,
          ...(body.level === undefined ? {} : { level: body.level }),
          ...(footprint === undefined ? {} : { footprint }),
        });
      } catch (error) {
        if (!(error instanceof SolverError)) throw error;
        throw new ProblemError({ status: 422, type: 'layout-unsolvable', title: 'no layout could be made from this brief', detail: `${error.message.charAt(0).toUpperCase()}${error.message.slice(1)}.`, head: MAIN });
      }

      const pending = await tx.changeset.findMany({ where: { projectId: project.id, status: 'pending' } });
      const byName = new Map(pending.map((c) => [c.name, c]));
      const taken = new Set(byName.keys());
      const proposals = toChangesetProposals(candidates);
      const out: (ReturnType<typeof report> & { changeset: ReturnType<typeof changesetView>; reused: boolean })[] = [];
      const events: ProjectEvent[] = [];
      for (const [i, proposal] of proposals.entries()) {
        const candidate = candidates[i] as Candidate;
        const batch = proposal.batch as unknown as Batch;
        const existing = byName.get(proposal.name);
        if (existing !== undefined && (await sameCandidate(tx, project.id, existing, main.hash, batch.length))) {
          const head = await tx.head.findUniqueOrThrow({ where: { projectId_name: { projectId: project.id, name: changesetHead(existing.id) } } });
          out.push({ ...report(candidate), changeset: changesetView(existing, { head: head.versionHash, ops: 1 }), reused: true });
          continue;
        }
        const name = freeName(proposal.name, taken);
        taken.add(name);
        const { changeset } = await openChangeset(tx, project.id, name, author);
        const head = changesetHead(changeset.id);
        const outcome = await applyToHead(tx, applier, { projectId: project.id, head, batch, author, kind: 'apply', changesetId: changeset.id });
        // The solver applied every candidate with the same applier before it answered: a refusal
        // here is a fault, and nothing of this request is kept.
        if (outcome.status === 'rejected') throw rejection(outcome.result, head);
        const view = committedView(outcome);
        events.push(changesetEvent(changeset, 'opened', { hash: view.hash, ops: await countChangesetOps(tx, changeset) }));
        out.push({ ...report(candidate), changeset: changesetView(changeset, { head: view.hash, ops: 1 }), reused: false });
      }

      const program = (main.document as { program?: { items?: object; adjacency?: unknown[] } }).program;
      const solved = {
        main: main.hash,
        items: Object.keys(program?.items ?? {}).length,
        adjacencies: program?.adjacency?.length ?? 0,
        footprint: footprint ?? null,
        level: body.level ?? null,
      };
      const opened = out.filter((c) => !c.reused).map((c) => c.changeset.id);
      return {
        reply: (res) => res.status(opened.length > 0 ? 201 : 200).json({ solved, candidates: out }),
        events,
        audit: {
          action: 'layouts.propose',
          targetType: 'project',
          targetId: project.id,
          detail: { project: project.id, main: main.hash, candidates: out.map((c) => ({ changeset: c.changeset.id, total: c.score.total, reused: c.reused })) },
        },
      };
    },
    { token: 'propose' },
  );

  return routes;
}
