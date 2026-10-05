import type { Diagnostic } from '@floorspec/engine';
import type { ChangesetRow } from '../editor/api';

/**
 * Layout candidates (FLR-T-4.3). `POST /api/projects/:id/layouts` runs the layout solver on main's
 * brief and opens one pending changeset per ranked candidate. A changeset has no field for the
 * solver's report, so its name carries the rank and the total — `Layout 1 of 3 (97.6): …` — and
 * the full report, which the answer holds, is kept in this browser beside the project. A
 * candidate's plan, its adjacency count and its findings are read from its changeset's head, by
 * the engine, like any other model.
 */

export interface Score {
  total: number;
  briefFit: number;
  circulation: number;
  findings: number;
}

export interface CandidateReport {
  rank: number;
  label: string;
  strategy: string;
  level: string;
  footprint: { width: number; depth: number };
  score: Score;
  explanation: string[];
  unplaced: { item: string; count: number; reason: string }[];
  ops: number;
  changeset: { id: string; name: string; status: string; base: string; head: string | null };
  reused: boolean;
}

export interface SolveAnswer {
  solved: { main: string; items: number; adjacencies: number; footprint: { width: number; depth: number } | null; level: string | null };
  candidates: CandidateReport[];
}

export interface SolveRequest {
  level?: string;
  footprint?: { width: number; depth: number };
  count?: number;
}

export type SolveOutcome =
  | { status: 'solved'; answer: SolveAnswer }
  | { status: 'unsolvable'; detail: string }
  | { status: 'rejected'; detail: string; diagnostics: Diagnostic[] }
  | { status: 'failed'; message: string };

export async function solveLayouts(projectId: string, request: SolveRequest): Promise<SolveOutcome> {
  let res: Response;
  try {
    res = await fetch(`/api/projects/${projectId}/layouts`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
  } catch {
    return { status: 'failed', message: 'The server did not answer. Nothing was changed.' };
  }
  const text = await res.text();
  let body: Record<string, unknown>;
  try {
    body = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
  } catch {
    body = {};
  }
  if (res.ok) return { status: 'solved', answer: body as unknown as SolveAnswer };
  const detail = typeof body['detail'] === 'string' ? body['detail'] : typeof body['error'] === 'string' ? body['error'] : `The server answered ${String(res.status)}.`;
  if (res.status === 422 && body['type'] === '/problems/layout-unsolvable') return { status: 'unsolvable', detail };
  if (res.status === 422 && Array.isArray(body['diagnostics'])) return { status: 'rejected', detail, diagnostics: body['diagnostics'] as Diagnostic[] };
  return { status: 'failed', message: detail };
}

// ─── The solver's reports, kept in this browser ──────────────────────────────────────────────

export interface Stored {
  solvedAt: string;
  solved: SolveAnswer['solved'];
  /** By changeset ID. */
  reports: Record<string, Omit<CandidateReport, 'changeset' | 'reused'>>;
}

const key = (projectId: string) => `floorspec.layouts.${projectId}`;

export function loadSolve(projectId: string): Stored | null {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(key(projectId));
    return raw === null ? null : (JSON.parse(raw) as Stored);
  } catch {
    return null;
  }
}

export function saveSolve(projectId: string, answer: SolveAnswer, at: Date = new Date()): Stored {
  const stored: Stored = {
    solvedAt: at.toISOString(),
    solved: answer.solved,
    reports: Object.fromEntries(answer.candidates.map(({ changeset, reused: _reused, ...report }) => [changeset.id, report])),
  };
  try {
    localStorage.setItem(key(projectId), JSON.stringify(stored));
  } catch {
    // Storage refused: the reports last for this visit.
  }
  return stored;
}

// ─── Candidates among the project's changesets ───────────────────────────────────────────────

const NAME = /^Layout (\d+) of (\d+) \((\d+(?:\.\d+)?)\): (.*?)(?: \((\d+)\))?$/;

/** A layout changeset's name, read back: `Layout 2 of 3 (97.2): Compact: …`. */
export function parseLayoutName(name: string): { rank: number; of: number; total: number; label: string } | null {
  const m = NAME.exec(name);
  if (m === null) return null;
  return { rank: Number(m[1]), of: Number(m[2]), total: Number(m[3]), label: (m[4] ?? '').replace(/…$/, '') };
}

export interface Candidate {
  row: ChangesetRow;
  rank: number;
  total: number;
  label: string;
}

export interface CandidateSets {
  /** Pending candidates solved on main as it is now, best first. */
  current: Candidate[];
  /** Pending candidates solved on an earlier main: the brief or the plan has moved since. */
  stale: Candidate[];
  /** The layout candidate last accepted into main, and the pending ones it supersedes (solved on its base). */
  accepted: { row: ChangesetRow; superseded: Candidate[] } | null;
}

/** Sort the project's changesets into layout candidates: current, stale, and an accepted one's leftovers. */
export function candidateSets(rows: readonly ChangesetRow[], main: string | null): CandidateSets {
  const layouts = rows.flatMap((row) => {
    const parsed = parseLayoutName(row.name);
    return parsed === null ? [] : [{ row, rank: parsed.rank, total: parsed.total, label: parsed.label }];
  });
  const pending = layouts.filter((c) => c.row.status === 'pending').sort((a, b) => a.rank - b.rank || b.total - a.total || (a.row.createdAt < b.row.createdAt ? 1 : -1));
  const acceptedRow = layouts.filter((c) => c.row.status === 'accepted').sort((a, b) => (a.row.createdAt < b.row.createdAt ? 1 : -1))[0]?.row;
  const superseded = acceptedRow === undefined ? [] : pending.filter((c) => c.row.base === acceptedRow.base);
  return {
    current: pending.filter((c) => c.row.base === main && !superseded.includes(c)),
    stale: pending.filter((c) => c.row.base !== main && !superseded.includes(c)),
    accepted: acceptedRow === undefined ? null : { row: acceptedRow, superseded },
  };
}

/** Candidate A, B, C… by rank. */
export const letter = (rank: number): string => (rank >= 1 && rank <= 26 ? String.fromCharCode(64 + rank) : String(rank));
