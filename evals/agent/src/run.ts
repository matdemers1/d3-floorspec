#!/usr/bin/env node
/**
 * The agent eval (FLR-T-2.9; FLR-REQ-054, FLR-REQ-055).
 *
 *   pnpm --filter @d3-floorspec/agent-eval eval [--tasks 001,002] [--runs N] [--model sonnet]
 *        [--agent claude|reference] [--concurrency 3] [--timeout 600] [--note "what changed"]
 *        [--database-url postgresql://…/floorspec_eval_test] [--out dir] [--fail-under 0.8]
 *
 * Starts the built API against a fresh `*_test` database, then for every task and run: a project,
 * the seed applied as Floorspec Ops, an agent token, Claude headless through the MCP shim, and the
 * assertions scored against the changeset its edits landed in. Writes results.json and report.md to
 * evals/agent/results/<timestamp>/. Needs `pnpm build` first (the API, the shim, the packages).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { AgentEnvironmentError, callMetrics, childEnv, runClaude, type AgentRun } from './agent.js';
import { DEFAULT_DATABASE_URL, Operator, REPO_ROOT, SERVER_ENTRY, SHIM, startApi, type ChangesetDetail } from './api.js';
import { measure, type Measured } from './measure.js';
import { runReference } from './reference.js';
import { markdownReport, summarise, type RunConfig, type TaskRun } from './report.js';
import { scoreMeasured } from './scorer.js';
import { EVAL_ROOT, hashOf, seedBatches, seedDocument } from './seeds.js';
import { loadTasks, promptFor } from './tasks.js';
import type { Task } from './types.js';

const { values } = parseArgs({
  options: {
    tasks: { type: 'string' },
    runs: { type: 'string', default: '1' },
    model: { type: 'string', default: 'sonnet' },
    agent: { type: 'string', default: 'claude' },
    concurrency: { type: 'string', default: '3' },
    timeout: { type: 'string', default: '600' },
    'database-url': { type: 'string', default: process.env['EVAL_DATABASE_URL'] ?? DEFAULT_DATABASE_URL },
    out: { type: 'string' },
    note: { type: 'string' },
    'max-budget-usd': { type: 'string' },
    'fail-under': { type: 'string' },
  },
});

const agent = values.agent === 'reference' ? 'reference' : 'claude';
const runs = Math.max(1, Number(values.runs));
const concurrency = Math.max(1, Number(values.concurrency));
const timeoutMs = Number(values.timeout) * 1000;
const tasks = loadTasks(values.tasks?.split(',').map((s) => s.trim()).filter((s) => s.length > 0));

for (const [what, path] of [['the API', SERVER_ENTRY], ['the MCP shim', SHIM]] as const) {
  if (!existsSync(path)) {
    process.stderr.write(`${what} is not built (${path}): run \`pnpm build\` first.\n`);
    process.exit(2);
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = values.out ?? join(EVAL_ROOT, 'results', `${stamp}${agent === 'reference' ? '-reference' : ''}`);
mkdirSync(join(outDir, 'transcripts'), { recursive: true });

function tryRun(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', cwd: REPO_ROOT, env: childEnv(), stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

const startedAt = new Date().toISOString();
const claudeVersion = agent === 'claude' ? tryRun('claude', ['--version']) : null;
if (agent === 'claude' && claudeVersion === null) {
  process.stderr.write('the claude CLI is not on PATH: npm install -g @anthropic-ai/claude-code\n');
  process.exit(2);
}

const seeds = new Map<string, { measured: Measured; hash: string; batches: readonly (readonly object[])[] }>();
for (const t of tasks) {
  const doc = seedDocument(t.seed);
  seeds.set(t.id, { measured: measure(doc), hash: hashOf(doc), batches: seedBatches(t.seed) });
}

const log = (line: string) => process.stdout.write(`${line}\n`);
log(`agent eval: ${String(tasks.length)} task(s) × ${String(runs)} run(s), agent ${agent}${agent === 'claude' ? ` (${claudeVersion ?? ''}, model ${values.model})` : ''} → ${outDir}`);

const api = await startApi(values['database-url'], join(outDir, 'server.log'));
const operator = new Operator(api.url);
await operator.setup();

const results: TaskRun[] = [];
const state: { aborted: string | null } = { aborted: null };

/** Which model to score: the agent's newest pending changeset with edits in it, else main. */
function pickChangeset(changesets: readonly ChangesetDetail[]): ChangesetDetail | null {
  const live = changesets.filter((c) => c.status === 'pending' && c.log.length > 0);
  live.sort((a, b) => (a.log.at(-1)?.createdAt ?? '').localeCompare(b.log.at(-1)?.createdAt ?? ''));
  return live.at(-1) ?? null;
}

async function one(task: Task, run: number): Promise<TaskRun> {
  const seed = seeds.get(task.id);
  if (seed === undefined) throw new Error(`no seed for ${task.id}`);
  const project = await operator.createProject(`${task.id} ${task.title} (run ${String(run)})`);
  for (const batch of seed.batches) await operator.applyToMain(project, batch);
  const main = await operator.model(project);
  if (main.hash !== seed.hash) throw new Error(`task ${task.id}: the seeded model is at ${main.hash}, expected ${seed.hash}`);
  const token = await operator.agentToken(project);

  let agentRun: AgentRun;
  try {
    agentRun =
      agent === 'reference'
        ? await runReference(task, api.url, token)
        : await runClaude({
            prompt: promptFor(task),
            apiUrl: api.url,
            token,
            model: values.model,
            timeoutMs,
            ...(values['max-budget-usd'] === undefined ? {} : { maxBudgetUsd: Number(values['max-budget-usd']) }),
          });
  } catch (error) {
    if (error instanceof AgentEnvironmentError) throw error;
    agentRun = { reply: '', calls: [], turns: null, costUsd: null, wallMs: 0, timedOut: false, error: error instanceof Error ? error.message : String(error), transcript: '' };
  }
  writeFileSync(join(outDir, 'transcripts', `${task.id}-run${String(run)}.${agent === 'claude' ? 'jsonl' : 'json'}`), agentRun.transcript);

  const changesets = await operator.changesets(project);
  const chosen = pickChangeset(changesets);
  const result = chosen === null ? main.document : (await operator.model(project, chosen.id)).document;
  const mainAfter = await operator.model(project);
  const score = scoreMeasured(seed.measured, measure(result), agentRun.reply, task.assertions);
  const error = agentRun.timedOut ? `timed out after ${String(timeoutMs / 1000)} s` : agentRun.error;
  const metrics = {
    ...callMetrics(agentRun.calls),
    turns: agentRun.turns,
    costUsd: agentRun.costUsd,
    wallMs: agentRun.wallMs,
    timedOut: agentRun.timedOut,
    opsCommitted: chosen === null ? 0 : chosen.log.reduce((n, row) => n + row.ops.length, 0),
    batchesCommitted: chosen === null ? 0 : chosen.log.length,
    changesets: changesets.length,
    mainChanged: mainAfter.hash !== main.hash,
  };
  return {
    task: task.id,
    title: task.title,
    category: task.category,
    run,
    pass: score.pass && error === undefined && !metrics.mainChanged,
    ...(error === undefined ? {} : { error }),
    assertions: score.results,
    metrics,
    scored: chosen === null ? 'main' : 'changeset',
    reply: agentRun.reply,
  };
}

const queue: [Task, number][] = [];
for (let r = 1; r <= runs; r++) for (const t of tasks) queue.push([t, r]);

async function worker(): Promise<void> {
  for (;;) {
    if (state.aborted !== null) return;
    const next = queue.shift();
    if (next === undefined) return;
    const [task, run] = next;
    try {
      const r = await one(task, run);
      results.push(r);
      log(`${r.pass ? 'pass' : 'FAIL'} ${task.id} run ${String(run)} ${task.title}${r.pass ? '' : ` — ${r.error ?? r.assertions.filter((a) => !a.pass).map((a) => `${a.kind}: ${a.detail}`).join('; ').slice(0, 300)}`}`);
    } catch (error) {
      if (error instanceof AgentEnvironmentError) {
        state.aborted = error.message;
        return;
      }
      throw error;
    }
  }
}

try {
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));
} finally {
  await api.stop();
}

if (state.aborted !== null) {
  process.stderr.write(`\nThe eval stopped: ${state.aborted}\nNo pass rate is reported — a run that could not reach Claude measures nothing.\n`);
  writeFileSync(join(outDir, 'ABORTED.txt'), `${state.aborted}\n`);
  process.exit(3);
}

const config: RunConfig = {
  startedAt,
  finishedAt: new Date().toISOString(),
  agent,
  model: agent === 'claude' ? values.model : 'n/a',
  claudeVersion,
  gitSha: tryRun('git', ['rev-parse', 'HEAD']),
  runs,
  tasks: tasks.map((t) => t.id),
  timeoutMs,
  bare: agent === 'claude' && typeof process.env['ANTHROPIC_API_KEY'] === 'string' && process.env['ANTHROPIC_API_KEY'].length > 0,
  ...(values.note === undefined ? {} : { note: values.note }),
};
results.sort((a, b) => a.run - b.run || a.task.localeCompare(b.task));
const summary = summarise(results, runs);
writeFileSync(join(outDir, 'results.json'), `${JSON.stringify({ config, summary, results }, null, 2)}\n`);
writeFileSync(join(outDir, 'report.md'), markdownReport(config, summary, results, tasks));
log(`\npass rate ${(summary.passRate * 100).toFixed(1)}% (${String(summary.passed)}/${String(summary.total)}); per run ${summary.perRun.map((x) => `${(x * 100).toFixed(1)}%`).join(', ')}`);
log(`report: ${join(outDir, 'report.md')}`);
if (process.env['GITHUB_OUTPUT'] !== undefined) {
  writeFileSync(process.env['GITHUB_OUTPUT'], `pass_rate=${summary.passRate.toFixed(4)}\nresults_dir=${outDir}\n`, { flag: 'a' });
}
const failUnder = values['fail-under'] === undefined ? null : Number(values['fail-under']);
process.exit(failUnder !== null && summary.passRate < failUnder ? 1 : 0);
