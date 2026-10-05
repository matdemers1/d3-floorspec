import type { CallMetrics } from './agent.js';
import type { AssertionResult, Task } from './types.js';

/** One task, one run: the score and what the agent did to get it. */
export interface TaskRun {
  readonly task: string;
  readonly title: string;
  readonly category: string;
  readonly run: number;
  readonly pass: boolean;
  /** Why it could not be scored or counted, when it could not: a timeout, a crash. */
  readonly error?: string;
  readonly assertions: readonly AssertionResult[];
  readonly metrics: CallMetrics & {
    readonly turns: number | null;
    readonly costUsd: number | null;
    readonly wallMs: number;
    readonly timedOut: boolean;
    /** Operations that landed in the scored changeset (from the server's op log). */
    readonly opsCommitted: number;
    /** Batches that landed (op log rows). */
    readonly batchesCommitted: number;
    /** Changesets the agent opened. */
    readonly changesets: number;
    /** Main must never move under an agent token (FLR-ADR-016). */
    readonly mainChanged: boolean;
  };
  /** Which model the score was read from. */
  readonly scored: 'changeset' | 'main';
  readonly reply: string;
  readonly transcript?: string;
}

export interface RunConfig {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly agent: 'claude' | 'reference' | 'proxy';
  readonly model: string;
  readonly claudeVersion: string | null;
  readonly gitSha: string | null;
  readonly runs: number;
  readonly tasks: readonly string[];
  readonly timeoutMs: number;
  readonly bare: boolean;
  /** Free text: what changed since the last run (a tool fix), passed with --note. */
  readonly note?: string;
}

export interface Summary {
  readonly total: number;
  readonly passed: number;
  readonly passRate: number;
  /** Pass rate of each run, in order. */
  readonly perRun: readonly number[];
  readonly min: number;
  readonly max: number;
  readonly byCategory: Readonly<Record<string, { passed: number; total: number }>>;
  /** Tasks that passed in some runs and failed in others. */
  readonly flaky: readonly string[];
  readonly averages: { readonly toolCalls: number; readonly opsCommitted: number; readonly rejectedBatches: number; readonly renderRequests: number; readonly turns: number | null; readonly wallSeconds: number; readonly costUsd: number | null };
}

const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

export function summarise(results: readonly TaskRun[], runs: number): Summary {
  const perRun = Array.from({ length: runs }, (_, r) => {
    const these = results.filter((x) => x.run === r + 1);
    return these.length === 0 ? 0 : these.filter((x) => x.pass).length / these.length;
  });
  const byCategory: Record<string, { passed: number; total: number }> = {};
  for (const r of results) {
    const c = (byCategory[r.category] ??= { passed: 0, total: 0 });
    c.total += 1;
    if (r.pass) c.passed += 1;
  }
  const ids = [...new Set(results.map((r) => r.task))];
  const flaky = ids.filter((id) => {
    const outcomes = new Set(results.filter((r) => r.task === id).map((r) => r.pass));
    return outcomes.size > 1;
  });
  const turns = results.map((r) => r.metrics.turns).filter((t): t is number => t !== null);
  const cost = results.map((r) => r.metrics.costUsd).filter((t): t is number => t !== null);
  const passed = results.filter((r) => r.pass).length;
  return {
    total: results.length,
    passed,
    passRate: results.length === 0 ? 0 : passed / results.length,
    perRun,
    min: Math.min(...perRun),
    max: Math.max(...perRun),
    byCategory,
    flaky,
    averages: {
      toolCalls: mean(results.map((r) => r.metrics.toolCalls)),
      opsCommitted: mean(results.map((r) => r.metrics.opsCommitted)),
      rejectedBatches: mean(results.map((r) => r.metrics.rejectedBatches)),
      renderRequests: mean(results.map((r) => r.metrics.renderRequests)),
      turns: turns.length === 0 ? null : mean(turns),
      wallSeconds: mean(results.map((r) => r.metrics.wallMs / 1000)),
      costUsd: cost.length === 0 ? null : cost.reduce((a, b) => a + b, 0),
    },
  };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n+/g, ' ');

export function markdownReport(config: RunConfig, summary: Summary, results: readonly TaskRun[], tasks: readonly Task[]): string {
  const out: string[] = [];
  const level = summary.passRate >= 0.8 ? 'at or above the 80% tripwire' : 'BELOW the 80% tripwire (FLR-REQ-055)';
  const verdict =
    config.agent === 'reference'
      ? 'harness self-check (scripted reference agent — not a measurement of Claude)'
      : config.agent === 'proxy'
        ? `${level} — measured by the proxy method: Claude subagents via the fs-mcp CLI, not \`claude -p\``
        : level;
  out.push(`# Agent eval — ${pct(summary.passRate)} (${String(summary.passed)}/${String(summary.total)})`, '');
  out.push(`**${verdict}.**`, '');
  out.push('| | |', '|---|---|');
  const agentRow =
    config.agent === 'claude'
      ? `Claude Code ${config.claudeVersion ?? '?'}, model \`${config.model}\`${config.bare ? ', --bare' : ''}`
      : config.agent === 'proxy'
        ? `**proxy — Claude subagents via fs-mcp CLI, not \`claude -p\`** (${config.model})`
        : 'scripted reference solutions through the MCP shim';
  out.push(`| Agent | ${agentRow} |`);
  out.push(`| Commit | \`${config.gitSha ?? 'unknown'}\` |`);
  out.push(`| Started | ${config.startedAt} |`, `| Finished | ${config.finishedAt} |`);
  out.push(`| Tasks × runs | ${String(config.tasks.length)} × ${String(config.runs)} |`);
  out.push(`| Pass rate per run | ${summary.perRun.map(pct).join(', ')} (min ${pct(summary.min)}, max ${pct(summary.max)}) |`);
  out.push(`| Flaky tasks | ${summary.flaky.length === 0 ? 'none' : summary.flaky.join(', ')} |`);
  const a = summary.averages;
  out.push(
    `| Per task, on average | ${a.toolCalls.toFixed(1)} tool calls, ${a.opsCommitted.toFixed(1)} ops committed, ${a.rejectedBatches.toFixed(2)} rejected batches, ${a.renderRequests.toFixed(1)} renders${a.turns === null ? '' : `, ${a.turns.toFixed(1)} turns`}, ${a.wallSeconds.toFixed(0)} s |`,
  );
  if (a.costUsd !== null) out.push(`| Total cost | $${a.costUsd.toFixed(2)} |`);
  if (config.note !== undefined) out.push(`| Note | ${cell(config.note)} |`);
  out.push('');

  out.push('## By category', '', '| Category | Passed |', '|---|---|');
  for (const [c, v] of Object.entries(summary.byCategory).sort()) out.push(`| ${c} | ${String(v.passed)}/${String(v.total)} |`);
  out.push('');

  out.push('## Tasks', '', `| Task | Category | ${Array.from({ length: config.runs }, (_, i) => `Run ${String(i + 1)}`).join(' | ')} | Ops | Rejected | Renders |`);
  out.push(`|---|---|${'---|'.repeat(config.runs)}---|---|---|`);
  for (const t of tasks) {
    const rs = results.filter((r) => r.task === t.id).sort((x, y) => x.run - y.run);
    if (rs.length === 0) continue;
    const marks = rs.map((r) => (r.pass ? 'pass' : r.error !== undefined ? '**error**' : '**FAIL**'));
    const sum = (f: (r: TaskRun) => number) => rs.map(f).join('/');
    out.push(`| ${t.id} ${cell(t.title)} | ${t.category} | ${marks.join(' | ')} | ${sum((r) => r.metrics.opsCommitted)} | ${sum((r) => r.metrics.rejectedBatches)} | ${sum((r) => r.metrics.renderRequests)} |`);
  }
  out.push('');

  const failures = results.filter((r) => !r.pass);
  out.push('## Failures', '');
  if (failures.length === 0) out.push('None.', '');
  for (const r of failures) {
    const task = tasks.find((t) => t.id === r.task);
    out.push(`### ${r.task} ${r.title} — run ${String(r.run)}`, '');
    out.push(`> ${task?.prompt ?? ''}`, '');
    if (r.error !== undefined) out.push(`**Run error:** ${r.error}`, '');
    out.push(`Scored the ${r.scored === 'changeset' ? 'agent\'s changeset' : 'main model (the agent opened no changeset)'}.`, '');
    for (const x of r.assertions.filter((x) => !x.pass)) out.push(`- **${x.kind}** — ${x.detail}`);
    out.push('');
    out.push(
      `Tools: ${Object.entries(r.metrics.byTool).map(([n, c]) => `${n.replace('floorspec_', '')}×${String(c)}`).join(', ') || 'none'}; ${String(r.metrics.batchesSent)} batch(es) sent, ${String(r.metrics.rejectedBatches)} rejected.`,
    );
    for (const why of r.metrics.rejections) out.push(`- rejected: ${cell(why)}`);
    out.push('', `Reply (last 600 characters): ${cell(r.reply.slice(-600)) || '(none)'}`, '');
  }
  return `${out.join('\n')}\n`;
}
