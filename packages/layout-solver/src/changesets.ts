/**
 * Candidates as changesets (FLR-ADR-016: agents propose, people dispose).
 *
 * Each candidate becomes the body of one `POST /api/projects/:projectId/changesets` — the server's
 * propose route (apps/server/src/routes/changesets.ts, `ProposeBody`):
 *
 *   { "name": string (1–120), "batch": Op[] (1–500), "context"?: { "locks"?: Lock[] } }
 *
 * — or, equally, one `floorspec_propose` MCP call ({ project, name, batch }). Each is a separate
 * pending changeset against main, so a person can open, compare and accept one. Accepting one
 * makes the others stop applying: their walls would land on a level that is no longer empty, and
 * their IDs are taken, so a replay is refused with FS-OPS-005 and they stay pending until rejected.
 */
import type { Operation } from '@floorspec/ops';
import type { Candidate } from './solve.js';

/** The server's limits on a propose body (ProposeBody / ApplyBody). */
export const MAX_CHANGESET_NAME = 120;
export const MAX_BATCH = 500;

export interface ChangesetProposal {
  /** The changeset's name, as a reviewer sees it in the list. */
  readonly name: string;
  readonly batch: Operation[];
}

export interface ProposalOptions {
  /** Prefix of every changeset name. Default "Layout". */
  readonly prefix?: string;
}

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

/** The propose bodies, best candidate first: `Layout 1 of 5 (82.4): Bedroom wing along a hall; …`. */
export function toChangesetProposals(candidates: readonly Candidate[], options: ProposalOptions = {}): ChangesetProposal[] {
  const prefix = options.prefix ?? 'Layout';
  return candidates.map((c) => {
    if (c.batch.length > MAX_BATCH) throw new RangeError(`candidate ${c.id} has ${String(c.batch.length)} operations; a changeset batch takes at most ${String(MAX_BATCH)}`);
    const name = clip(`${prefix} ${String(c.rank)} of ${String(candidates.length)} (${c.score.total.toFixed(1)}): ${c.label}`, MAX_CHANGESET_NAME);
    return { name, batch: c.batch };
  });
}
