import { z } from 'zod';
import { parseLength } from '@floorspec/ops';
import { PlanError, proposeElectrical, type ElectricalProposal } from '@floorspec/assistant-electrical';
import type { Db } from '../db.js';
import { Routes, type MutationResult } from '../http/routes.js';
import { HttpError } from '../http/errors.js';
import { ProblemError } from '../http/problem.js';
import type { Applier, Batch } from '../ops/applier.js';
import { MAIN } from '../domain/projects.js';
import { applyToHead, authorOf, changesetHead, lockProject, readHead, retiredFor } from '../domain/history.js';
import { changesetView, openChangeset } from '../domain/changesets.js';
import { changesetEvent, countChangesetOps } from '../events/publish.js';
import { committedView, rejection } from './history.js';
import { freeName } from './layouts.js';
import { parse } from './auth.js';

/** A length: an integer in base units, or the reference grammar ("12'", "3.6 m"). */
const Length = z.union([z.int().min(1).max(Number.MAX_SAFE_INTEGER), z.string().trim().min(1).max(64)]);

export const ElectricalBody = z.strictObject({
  /** Only the rooms on this level. */
  level: z.string().trim().min(1).max(64).optional(),
  /** Only these rooms: IDs or names. */
  rooms: z.array(z.string().trim().min(1).max(200)).min(1).max(200).optional(),
  /** Which parts to propose; all by default. */
  include: z
    .strictObject({ receptacles: z.boolean().optional(), switches: z.boolean().optional(), lights: z.boolean().optional(), circuits: z.boolean().optional() })
    .optional(),
  /** Floorspec's default receptacle spacing along a wall run, overridden. */
  spacing: Length.optional(),
});

/** What the answer says of a proposal besides its changeset. */
export function proposalView(p: ElectricalProposal) {
  return {
    name: p.name,
    explanation: p.explanation,
    added: p.added,
    circuits: p.circuits,
    upgraded: p.upgraded,
    gaps: p.gaps.length,
    rooms: p.rooms,
    notes: p.notes,
    ops: p.batch.length,
  };
}

/**
 * The electrical layout assistant (FLR-T-5.8, FLR-REQ-090): run the non-normative assistant
 * (`@floorspec/assistant-electrical`) on main and open its proposal — receptacles, GFCI and AFCI,
 * switches, lights, circuits — as one pending changeset. Nothing is written to main; a person
 * accepts it (FLR-ADR-016). Its heuristics are Floorspec's own defaults and it never claims a
 * design meets a code (FLR-ADR-011): advisory findings arrive with the rules packs.
 *
 * An agent token may call it (scope `propose`): what it makes is a changeset, as `POST /changesets`.
 */
export function assistantRoutes(db: Db, applier: Applier): Routes {
  const routes = new Routes(db);

  routes.mutate(
    'POST',
    '/:projectId/assistants/electrical',
    async (req, tx): Promise<MutationResult> => {
      const project = req.project;
      if (project === undefined) throw new HttpError(404, 'project not found');
      const body = parse(ElectricalBody, req.body ?? {});
      let spacing: number | undefined;
      if (body.spacing !== undefined) {
        if (typeof body.spacing === 'number') spacing = body.spacing;
        else {
          const parsed = parseLength(body.spacing);
          if (!parsed.ok || parsed.value <= 0n || parsed.value > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new HttpError(400, 'the request body is not valid', { fields: [{ path: 'spacing', message: parsed.ok ? 'a spacing is longer than zero' : parsed.reason }] });
          }
          spacing = Number(parsed.value);
        }
      }
      const author = authorOf(req);

      await lockProject(tx, project.id);
      const main = await readHead(tx, project.id, MAIN);
      const doc = main.document as { rooms?: Record<string, { name?: string }> };
      // Rooms by ID, or by name ignoring case when exactly one room has it (Ops 3.3).
      const rooms = body.rooms?.map((ref) => {
        if (Object.hasOwn(doc.rooms ?? {}, ref)) return ref;
        const named = Object.entries(doc.rooms ?? {}).filter(([, r]) => r.name?.toLowerCase() === ref.toLowerCase());
        if (named.length !== 1) throw new HttpError(400, 'the request body is not valid', { fields: [{ path: 'rooms', message: `no room is called "${ref}", or more than one is` }] });
        return named[0]?.[0] as string;
      });
      let proposal: ElectricalProposal;
      try {
        proposal = proposeElectrical(main.document as object, {
          retired: await retiredFor(tx, project.id),
          ...(body.level === undefined ? {} : { level: body.level }),
          ...(rooms === undefined ? {} : { rooms }),
          ...(body.include === undefined ? {} : { include: body.include }),
          ...(spacing === undefined ? {} : { defaults: { receptacleSpacing: spacing } }),
        });
      } catch (error) {
        if (!(error instanceof PlanError)) throw error;
        throw new ProblemError({ status: 422, type: 'electrical-unproposable', title: 'no electrical layout could be proposed', detail: `${error.message.charAt(0).toUpperCase()}${error.message.slice(1)}.`, head: MAIN });
      }

      const view = proposalView(proposal);
      if (proposal.batch.length === 0) {
        return {
          reply: (res) => res.status(200).json({ main: main.hash, changeset: null, proposal: view }),
          audit: { action: 'assistants.electrical.propose', targetType: 'project', targetId: project.id, detail: { project: project.id, main: main.hash, changeset: null, ops: 0 } },
        };
      }
      const pending = await tx.changeset.findMany({ where: { projectId: project.id, status: 'pending' }, select: { name: true } });
      const name = freeName(proposal.name, new Set(pending.map((c) => c.name)));
      const { changeset } = await openChangeset(tx, project.id, name, author);
      const head = changesetHead(changeset.id);
      const outcome = await applyToHead(tx, applier, { projectId: project.id, head, batch: proposal.batch as unknown as Batch, author, kind: 'apply', changesetId: changeset.id });
      // The assistant reads the plan with the same engine the applier validates with: a refusal
      // here is a fault in the assistant, and nothing of this request is kept.
      if (outcome.status === 'rejected') throw rejection(outcome.result, head);
      const committed = committedView(outcome);
      return {
        reply: (res) => res.status(201).json({ main: main.hash, changeset: changesetView(changeset, { head: committed.hash, ops: 1 }), proposal: view }),
        events: [changesetEvent(changeset, 'opened', { hash: committed.hash, ops: await countChangesetOps(tx, changeset) })],
        audit: {
          action: 'assistants.electrical.propose',
          targetType: 'project',
          targetId: project.id,
          detail: { project: project.id, main: main.hash, changeset: changeset.id, ops: proposal.batch.length, added: proposal.added, circuits: proposal.circuits.map((c) => c.id) },
        },
      };
    },
    { token: 'propose' },
  );

  return routes;
}
