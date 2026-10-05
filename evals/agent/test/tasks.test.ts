import { describe, expect, it } from 'vitest';
import { measure } from '../src/measure.js';
import { scoreMeasured } from '../src/scorer.js';
import { applyBatches, seedDocument } from '../src/seeds.js';
import { loadTasks, promptFor } from '../src/tasks.js';

/**
 * The self-check every task must pass before it can score an agent: each reference solution — a
 * scripted correct edit, applied with the reference applier exactly as the server would — passes
 * every assertion, and doing nothing fails. A task whose assertions reject a correct edit, or
 * accept no edit, is a broken task, not a hard one.
 */
const tasks = loadTasks();

describe('the task set', () => {
  it('has at least thirty tasks (FLR-REQ-054)', () => {
    expect(tasks.length).toBeGreaterThanOrEqual(30);
  });

  it('asks a read-only task for an ANSWER line and leaves every other prompt as the homeowner typed it', () => {
    for (const task of tasks) {
      if (task.answer === undefined) expect(promptFor(task)).toBe(task.prompt);
      else expect(promptFor(task)).toMatch(/ANSWER:/);
    }
  });
});

describe.each(tasks.map((t) => [`${t.id} ${t.title}`, t] as const))('%s', (_name, task) => {
  const seed = seedDocument(task.seed);
  const seedMeasured = measure(seed);

  it('starts from a valid seed', () => {
    expect(seedMeasured.valid, JSON.stringify(seedMeasured.diagnostics)).toBe(true);
  });

  it('fails when the agent does nothing and says nothing', () => {
    const result = scoreMeasured(seedMeasured, seedMeasured, '', task.assertions);
    expect(result.pass).toBe(false);
  });

  for (const [i, ref] of task.references.entries()) {
    it(`passes reference ${String(i + 1)}${ref.label === undefined ? '' : ` (${ref.label})`}`, () => {
      const after = ref.batches === undefined ? seed : applyBatches(seed, ref.batches);
      const result = scoreMeasured(seedMeasured, measure(after), ref.reply ?? '', task.assertions);
      expect(result.results.filter((r) => !r.pass)).toEqual([]);
    });
  }
});
