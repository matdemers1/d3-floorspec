#!/usr/bin/env node
/**
 * The proxy eval (FLR-T-2.9): until the eval has an API key for `claude -p`, Claude is measured by
 * running fresh Claude subagents as the agent under test, each talking to `/mcp` through the
 * `bin/fs-mcp` CLI with its task's agent token. Everything it produces is labelled as the proxy
 * method — it is not the `claude -p` run FLR-REQ-055 is written against.
 *
 *   tsx src/proxy.ts serve   [--port 3471] [--database-url …_test]     the API, once, and stays up
 *   tsx src/proxy.ts prepare <taskId> [--run N] [--force]             a project, seed and agent token
 *   tsx src/proxy.ts score   <taskId> [--run N] [--out dir]           score it; append to results.json
 *   tsx src/proxy.ts report  --proxy <dir> [--model "…"]              write report.md for a proxy run
 *
 * Layout, under evals/agent/.proxy/ (git-ignored):
 *   server.json                    { url, port, databaseUrl, pid, startedAt, operator: { email, session } }
 *   server.log                     the API's log
 *   <taskId>-<run>/session.json    { url, token, projectId, prompt, taskId, run, seedHash, answerFile, createdAt }
 *   <taskId>-<run>/calls.jsonl     one line per fs-mcp invocation (tools, call, prompt)
 *   <taskId>-<run>/renders/*.png   every image a tool returned
 *   <taskId>-<run>/answer.txt      the agent's final reply, written by the agent
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { callMetrics, type ToolCall } from './agent.js';
import { DEFAULT_DATABASE_URL, EVAL_OPERATOR, Operator, REPO_ROOT, SERVER_ENTRY, startApi, type ChangesetDetail } from './api.js';
import { measure } from './measure.js';
import { markdownReport, summarise, type RunConfig, type TaskRun } from './report.js';
import { scoreMeasured } from './scorer.js';
import { EVAL_ROOT, hashOf, seedBatches, seedDocument } from './seeds.js';
import { loadTasks, promptFor } from './tasks.js';
import type { Task } from './types.js';

export const PROXY_DIR = join(EVAL_ROOT, '.proxy');
export const SERVER_FILE = join(PROXY_DIR, 'server.json');
export const FS_MCP = join(EVAL_ROOT, 'bin/fs-mcp');
export const DEFAULT_PORT = 3471;
export const PROXY_METHOD = 'proxy — Claude subagents via fs-mcp CLI, not `claude -p`';

export interface ServerFile {
  readonly url: string;
  readonly port: number;
  readonly databaseUrl: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly operator: { readonly email: string; readonly session: string };
}

export interface SessionFile {
  readonly url: string;
  readonly token: string;
  readonly projectId: string;
  readonly prompt: string;
  readonly taskId: string;
  readonly run: number;
  readonly seedHash: string;
  readonly answerFile: string;
  readonly createdAt: string;
}

export interface CallLogEntry {
  readonly at: string;
  readonly kind: 'tools' | 'call' | 'prompt';
  readonly tool?: string;
  readonly args?: unknown;
  readonly isError?: boolean;
  readonly protocolError?: boolean;
  readonly parseError?: string;
  readonly text?: string;
  readonly images?: readonly string[];
}

const out = (line: string) => process.stdout.write(`${line}\n`);
const fail = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(2);
};

export function sessionDir(taskId: string, run: number): string {
  return join(PROXY_DIR, `${taskId}-${String(run)}`);
}

function readServer(): ServerFile {
  if (!existsSync(SERVER_FILE)) fail(`no eval server is running (${SERVER_FILE} is missing): start it with \`pnpm --filter @d3-floorspec/agent-eval serve\``);
  return JSON.parse(readFileSync(SERVER_FILE, 'utf8')) as ServerFile;
}

async function liveServer(): Promise<ServerFile> {
  const server = readServer();
  try {
    const res = await fetch(`${server.url}/readyz`);
    if (!res.ok) throw new Error(String(res.status));
  } catch (error) {
    fail(`the eval server at ${server.url} is not answering (${error instanceof Error ? error.message : String(error)}): restart \`serve\``);
  }
  return server;
}

function oneTask(id: string | undefined): Task {
  if (id === undefined) fail('name a task: e.g. 001');
  const [task] = loadTasks([id as string]);
  if (task === undefined) fail(`no task ${String(id)}`);
  return task as Task;
}

// ─── serve ──────────────────────────────────────────────────────────────────

async function serve(port: number, databaseUrl: string): Promise<void> {
  if (!existsSync(SERVER_ENTRY)) fail(`the API is not built (${SERVER_ENTRY}): run \`pnpm build\` first`);
  mkdirSync(PROXY_DIR, { recursive: true });
  const api = await startApi(databaseUrl, join(PROXY_DIR, 'server.log'), port);
  const operator = new Operator(api.url);
  await operator.setup();
  const file: ServerFile = {
    url: api.url,
    port,
    databaseUrl,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    operator: { email: EVAL_OPERATOR.email, session: operator.session },
  };
  writeFileSync(SERVER_FILE, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  out(`eval server ready at ${api.url} (database ${new URL(databaseUrl).pathname.slice(1)}, fresh)`);
  out(`wrote ${SERVER_FILE}; prepare a task with: pnpm --filter @d3-floorspec/agent-eval prepare 001`);
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    out(`${signal}: stopping the eval server`);
    rmSync(SERVER_FILE, { force: true });
    void api.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', () => {
    stop('SIGINT');
  });
  process.on('SIGTERM', () => {
    stop('SIGTERM');
  });
  api.child.on('exit', (code) => {
    if (stopping) return;
    rmSync(SERVER_FILE, { force: true });
    process.stderr.write(`the API exited (${String(code)}); see ${join(PROXY_DIR, 'server.log')}\n`);
    process.exit(1);
  });
}

// ─── prepare ────────────────────────────────────────────────────────────────

async function prepare(taskId: string | undefined, run: number, force: boolean): Promise<void> {
  if (taskId === undefined) {
    // No task: print usage and succeed (pnpm may also run a script named "prepare" on install).
    out('usage: pnpm --filter @d3-floorspec/agent-eval prepare <taskId> [--run N] [--force]');
    return;
  }
  const task = oneTask(taskId);
  const server = await liveServer();
  const dir = sessionDir(task.id, run);
  if (existsSync(dir)) {
    if (!force) fail(`${dir} already exists: score it, or pass --force to start that run again`);
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
  const operator = Operator.resume(server.url, server.operator.session);
  const projectId = await operator.createProject(`${task.id} ${task.title} (proxy run ${String(run)})`);
  for (const batch of seedBatches(task.seed)) await operator.applyToMain(projectId, batch);
  const seedHash = hashOf(seedDocument(task.seed));
  const main = await operator.model(projectId);
  if (main.hash !== seedHash) fail(`the seeded model is at ${main.hash}, expected ${seedHash}`);
  const token = await operator.agentToken(projectId);
  const session: SessionFile = {
    url: server.url,
    token,
    projectId,
    prompt: promptFor(task),
    taskId: task.id,
    run,
    seedHash,
    answerFile: join(dir, 'answer.txt'),
    createdAt: new Date().toISOString(),
  };
  const file = join(dir, 'session.json');
  writeFileSync(file, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  out(`Task ${task.id} run ${String(run)}: ${task.title}`);
  out(`session: ${file}`);
  out('');
  out('── Prompt (give the agent exactly this) ──');
  out(session.prompt);
  out('');
  out('── How the agent works ──');
  out(`  ${FS_MCP} ${file} prompt design-partner          # the system prompt the plugin gives Claude`);
  out(`  ${FS_MCP} ${file} tools                          # the tools, as an MCP client sees them`);
  out(`  ${FS_MCP} ${file} call <tool> '<json args>'      # one tool call; images are saved, their path printed`);
  out(`  then write the final reply (including any ANSWER: line) to ${session.answerFile}`);
  out('');
  out(`Score it with: pnpm --filter @d3-floorspec/agent-eval score ${task.id}${run === 1 ? '' : ` --run ${String(run)}`}`);
}

// ─── score ──────────────────────────────────────────────────────────────────

function readLog(dir: string): CallLogEntry[] {
  const file = join(dir, 'calls.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as CallLogEntry);
}

function pickChangeset(changesets: readonly ChangesetDetail[]): ChangesetDetail | null {
  const live = changesets.filter((c) => c.status === 'pending' && c.log.length > 0);
  live.sort((a, b) => (a.log.at(-1)?.createdAt ?? '').localeCompare(b.log.at(-1)?.createdAt ?? ''));
  return live.at(-1) ?? null;
}

export function defaultProxyDir(): string {
  const d = new Date();
  const date = `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return join(EVAL_ROOT, 'results', `proxy-${date}`);
}

interface ProxyResults {
  readonly method: string;
  config: RunConfig;
  results: TaskRun[];
}

async function score(taskId: string | undefined, run: number, outDir: string, model: string | undefined): Promise<void> {
  const task = oneTask(taskId);
  const dir = sessionDir(task.id, run);
  const sessionFile = join(dir, 'session.json');
  if (!existsSync(sessionFile)) fail(`no session ${sessionFile}: prepare it first`);
  const session = JSON.parse(readFileSync(sessionFile, 'utf8')) as SessionFile;
  const server = await liveServer();
  if (server.url !== session.url) fail(`the session was prepared against ${session.url}, but the server is at ${server.url}`);
  const operator = Operator.resume(server.url, server.operator.session);

  const seed = seedDocument(task.seed);
  const changesets = await operator.changesets(session.projectId);
  const chosen = pickChangeset(changesets);
  const main = await operator.model(session.projectId);
  const result = chosen === null ? main.document : (await operator.model(session.projectId, chosen.id)).document;
  const answerFile = join(dir, 'answer.txt');
  const reply = existsSync(answerFile) ? readFileSync(answerFile, 'utf8') : '';
  const log = readLog(dir);
  const calls: ToolCall[] = log
    .filter((e) => e.kind === 'call')
    .map((e, i) => ({
      id: String(i),
      name: e.tool ?? '',
      input: typeof e.args === 'object' && e.args !== null ? (e.args as Record<string, unknown>) : {},
      isError: e.isError === true || e.parseError !== undefined,
      resultText: e.text ?? '',
    }));
  const times = log.map((e) => Date.parse(e.at)).filter((t) => !Number.isNaN(t));
  const end = existsSync(answerFile) ? statSync(answerFile).mtimeMs : Math.max(...times, Date.parse(session.createdAt));
  const s = scoreMeasured(measure(seed), measure(result), reply, task.assertions);
  const mainChanged = main.hash !== session.seedHash;
  const error = reply.trim().length === 0 ? 'no answer.txt: the agent did not write its final reply' : undefined;
  const entry: TaskRun & { proxy: Record<string, unknown> } = {
    task: task.id,
    title: task.title,
    category: task.category,
    run,
    pass: s.pass && !mainChanged && error === undefined,
    ...(error === undefined ? {} : { error }),
    assertions: s.results,
    metrics: {
      ...callMetrics(calls),
      turns: null,
      costUsd: null,
      wallMs: Math.max(0, end - Date.parse(session.createdAt)),
      timedOut: false,
      opsCommitted: chosen === null ? 0 : chosen.log.reduce((n, row) => n + row.ops.length, 0),
      batchesCommitted: chosen === null ? 0 : chosen.log.length,
      changesets: changesets.length,
      mainChanged,
    },
    scored: chosen === null ? 'main' : 'changeset',
    reply,
    proxy: {
      calls: calls.length,
      invocations: log.length,
      listedTools: log.some((e) => e.kind === 'tools'),
      readPrompt: log.some((e) => e.kind === 'prompt'),
      sessionDir: dir,
    },
  };

  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, 'results.json');
  const existing: ProxyResults = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as ProxyResults)
    : { method: PROXY_METHOD, config: proxyConfig([], model), results: [] };
  // Re-scoring a task and run replaces its entry rather than counting it twice.
  existing.results = [...existing.results.filter((r) => !(r.task === entry.task && r.run === entry.run)), entry].sort((a, b) => a.run - b.run || a.task.localeCompare(b.task));
  existing.config = proxyConfig(existing.results, model ?? existing.config.model, existing.config.startedAt);
  writeFileSync(file, `${JSON.stringify(existing, null, 2)}\n`);

  out(`${entry.pass ? 'PASS' : 'FAIL'} ${task.id} run ${String(run)} ${task.title} (scored the ${entry.scored === 'changeset' ? 'agent\'s changeset' : 'main model'})`);
  for (const r of s.results) out(`  ${r.pass ? 'ok  ' : 'FAIL'} ${r.kind}: ${r.detail}`);
  if (error !== undefined) out(`  FAIL ${error}`);
  if (mainChanged) out('  FAIL main changed under an agent token');
  out(`  ${String(calls.length)} tool call(s), ${String(entry.metrics.rejectedBatches)} rejected batch(es), ${String(entry.metrics.renderRequests)} render(s), ${String(entry.metrics.opsCommitted)} op(s) committed`);
  out(`appended to ${file}`);
}

function proxyConfig(results: readonly TaskRun[], model: string | undefined, startedAt?: string): RunConfig {
  return {
    startedAt: startedAt ?? new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    agent: 'proxy',
    model: model ?? 'Claude subagent (model as launched by the lead session)',
    claudeVersion: null,
    gitSha: gitSha(),
    runs: results.reduce((m, r) => Math.max(m, r.run), 1),
    tasks: [...new Set(results.map((r) => r.task))].sort(),
    timeoutMs: 0,
    bare: false,
    note: PROXY_METHOD,
  };
}

function gitSha(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

// ─── report ─────────────────────────────────────────────────────────────────

function report(dir: string | undefined, model: string | undefined): void {
  if (dir === undefined) fail('usage: report --proxy <results dir>');
  const file = join(resolve(dir as string), 'results.json');
  if (!existsSync(file)) fail(`no ${file}`);
  const data = JSON.parse(readFileSync(file, 'utf8')) as ProxyResults;
  const config = proxyConfig(data.results, model ?? data.config.model, data.config.startedAt);
  const summary = summarise(data.results, config.runs);
  const tasks = loadTasks().filter((t) => config.tasks.includes(t.id));
  const md = markdownReport(config, summary, data.results, tasks);
  const target = join(resolve(dir as string), 'report.md');
  writeFileSync(target, md);
  writeFileSync(file, `${JSON.stringify({ ...data, config, summary }, null, 2)}\n`);
  out(`${(summary.passRate * 100).toFixed(1)}% (${String(summary.passed)}/${String(summary.total)}) — ${PROXY_METHOD}`);
  out(`wrote ${target}`);
}

// ─── main ───────────────────────────────────────────────────────────────────

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    run: { type: 'string', default: '1' },
    force: { type: 'boolean', default: false },
    port: { type: 'string', default: process.env['EVAL_PORT'] ?? String(DEFAULT_PORT) },
    'database-url': { type: 'string', default: process.env['EVAL_DATABASE_URL'] ?? DEFAULT_DATABASE_URL },
    out: { type: 'string' },
    proxy: { type: 'string' },
    model: { type: 'string' },
  },
});
const [command, taskId] = positionals;
const run = Math.max(1, Number(values.run));

switch (command) {
  case 'serve':
    await serve(Number(values.port), values['database-url']);
    break;
  case 'prepare':
    await prepare(taskId, run, values.force);
    break;
  case 'score':
    await score(taskId, run, values.out ?? defaultProxyDir(), values.model);
    break;
  case 'report':
    report(values.proxy ?? taskId, values.model);
    break;
  default:
    fail('usage: proxy.ts serve | prepare <taskId> [--run N] | score <taskId> [--run N] | report --proxy <dir>');
}
