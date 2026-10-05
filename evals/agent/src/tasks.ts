import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EVAL_ROOT } from './seeds.js';
import type { AnswerFormat, Task } from './types.js';

export const TASKS_DIR = join(EVAL_ROOT, 'tasks');

const FILE = /^(\d{3})-[a-z0-9-]+\.json$/;

/** Every task, in ID order; `only` narrows to these IDs ("001", "7", "012-…"). */
export function loadTasks(only?: readonly string[]): Task[] {
  const files = readdirSync(TASKS_DIR).filter((f) => f.endsWith('.json')).sort();
  const tasks: Task[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const m = FILE.exec(file);
    if (m === null) throw new Error(`task file ${file} is not named NNN-slug.json`);
    const task = JSON.parse(readFileSync(join(TASKS_DIR, file), 'utf8')) as Task;
    const problems = checkTask(task, m[1] ?? '');
    if (problems.length > 0) throw new Error(`${file}: ${problems.join('; ')}`);
    if (seen.has(task.id)) throw new Error(`${file}: duplicate task id ${task.id}`);
    seen.add(task.id);
    tasks.push(task);
  }
  if (only === undefined || only.length === 0) return tasks;
  const wanted = only.map((s) => s.split('-')[0]?.padStart(3, '0') ?? s);
  const picked = tasks.filter((t) => wanted.includes(t.id));
  const missing = wanted.filter((w) => !picked.some((t) => t.id === w));
  if (missing.length > 0) throw new Error(`no task ${missing.join(', ')}`);
  return picked;
}

function checkTask(task: Task, number: string): string[] {
  const problems: string[] = [];
  if (task.id !== number) problems.push(`id "${task.id}" does not match the file number ${number}`);
  for (const key of ['title', 'category', 'prompt'] as const) if (typeof task[key] !== 'string' || task[key].length === 0) problems.push(`${key} is missing`);
  if ((task as Partial<Task>).seed === undefined) problems.push('seed is missing');
  if (!Array.isArray(task.assertions) || task.assertions.length === 0) problems.push('no assertions');
  if (!Array.isArray(task.references) || task.references.length === 0) problems.push('no reference solution');
  const reads = JSON.stringify(task.assertions).includes('"kind":"answer"');
  if (reads && task.answer === undefined) problems.push('an answer assertion needs answer.format');
  return problems;
}

const FORMATS: Record<AnswerFormat, string> = {
  rooms: 'the room names, separated by commas',
  number: 'just the number, in the units asked for',
  yesno: 'yes or no',
  list: 'the items, separated by commas',
};

/**
 * The prompt Claude receives. A read-only task gets one sentence added, so its answer can be scored
 * without a judge: the reply must end with an `ANSWER:` line. Nothing else is added — the homeowner's
 * words are the task.
 */
export function promptFor(task: Task): string {
  if (task.answer === undefined) return task.prompt;
  return `${task.prompt}\n\n(Finish your reply with one last line that starts with "ANSWER:" followed by ${FORMATS[task.answer.format]}.)`;
}
