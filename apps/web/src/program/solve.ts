import type { EditorStore } from '../editor/store';
import { addLevel, DEFAULT_LEVEL_HEIGHT } from '../editor/ops';
import { saveSolve, solveLayouts, type SolveAnswer, type SolveRequest } from './candidates';

export type RunOutcome = { status: 'solved'; answer: SolveAnswer } | { status: 'problem'; message: string };

/**
 * Solve the brief from the browser. A plan with no level at all gets Level 1 first, as an edit of
 * its own (so Undo takes it back): every candidate is then drawn on that one level, and accepting
 * one makes the others stop applying. The solver's reports are kept for the candidates screen.
 */
export async function runSolve(store: EditorStore, request: SolveRequest): Promise<RunOutcome> {
  const model = store.get().model;
  if (model === null) return { status: 'problem', message: 'The plan has not loaded yet.' };
  if (model.levels.length === 0) {
    const ok = await store.apply('Add Level 1', addLevel(model.document, { name: 'Level 1', elevation: 0, height: DEFAULT_LEVEL_HEIGHT }));
    if (!ok) return { status: 'problem', message: 'Level 1 could not be added, so there is nowhere to lay the brief out.' };
  }
  const outcome = await solveLayouts(store.projectId, request);
  if (outcome.status === 'solved') {
    saveSolve(store.projectId, outcome.answer);
    return outcome;
  }
  return { status: 'problem', message: outcome.status === 'failed' ? outcome.message : outcome.detail };
}
