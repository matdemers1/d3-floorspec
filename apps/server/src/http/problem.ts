import type { Response } from 'express';

/**
 * An RFC 9457 problem document. The API's errors are problem+json (foreman://FLR/api-contract);
 * `error` repeats the title because every client of this API already reads that member.
 */
export interface Problem {
  readonly status: number;
  readonly title: string;
  readonly detail?: string;
  /** A short slug, resolved against `/problems/`: `ops-rejected`, `stale-head`, `replay-failed`… */
  readonly type?: string;
  readonly [extension: string]: unknown;
}

export function sendProblem(res: Response, problem: Problem): void {
  const { type, ...rest } = problem;
  res
    .status(problem.status)
    .type('application/problem+json')
    .send(JSON.stringify({ type: type === undefined ? 'about:blank' : `/problems/${type}`, ...rest, error: problem.title }));
}

/** Thrown from a handler when the answer is a problem document; the app's error handler sends it. */
export class ProblemError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.title);
    this.name = 'ProblemError';
  }
}
