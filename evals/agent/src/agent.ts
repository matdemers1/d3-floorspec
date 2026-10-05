import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOOL_NAMES } from '@floorspec/mcp';
import { REPO_ROOT, SHIM } from './api.js';

/**
 * Claude, headless: `claude -p` with one MCP server — the stdio shim (`packages/mcp-stdio`) pointed
 * at the local API with the task's agent token — the ten floorspec tools allowed and every built-in
 * tool removed (no Bash, no Edit, no Web), and the plugin's design-partner skill appended to the
 * system prompt. The run is read back from `--output-format stream-json`.
 */

export const MCP_SERVER = 'floorspec';
export const ALLOWED_TOOLS = TOOL_NAMES.map((t) => `mcp__${MCP_SERVER}__${t}`);
export const SKILL_FILE = join(REPO_ROOT, 'plugin/skills/floorspec-design-partner/SKILL.md');

/** The skill's body, without its YAML front matter: what the plugin puts in front of Claude. */
export function designPartnerPrompt(): string {
  const text = readFileSync(SKILL_FILE, 'utf8');
  return text.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
  isError?: boolean;
  resultText?: string;
}

export interface AgentRun {
  /** The final reply. */
  readonly reply: string;
  readonly calls: readonly ToolCall[];
  readonly turns: number | null;
  readonly costUsd: number | null;
  readonly wallMs: number;
  readonly timedOut: boolean;
  /** Set when the run itself failed (not the task): an API error, a crash. */
  readonly error?: string;
  /** Raw stream-json lines, for the transcript file. */
  readonly transcript: string;
}

/** The run cannot be scored because the environment is broken (no credentials, no CLI). Stops the eval. */
export class AgentEnvironmentError extends Error {}

export interface ClaudeOptions {
  readonly prompt: string;
  readonly apiUrl: string;
  readonly token: string;
  readonly model?: string;
  readonly timeoutMs: number;
  readonly maxBudgetUsd?: number;
  readonly claudeBin?: string;
}

/**
 * Host-session variables that make a nested `claude` try to borrow its parent's sign-in (and fail
 * with "OAuth session expired and could not be refreshed"): a child run must authenticate on its
 * own, with ANTHROPIC_API_KEY or its own login.
 */
const HOST_ONLY = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_.*|CLAUDE_AGENT_SDK_.*|CLAUDE_PREVIEW_.*)$/;

export function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!HOST_ONLY.test(k)) env[k] = v;
  return env;
}

export function claudeArgs(options: ClaudeOptions, mcpConfig: string, bare: boolean): string[] {
  return [
    '-p',
    options.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--mcp-config',
    mcpConfig,
    '--strict-mcp-config',
    // No built-in tools at all; only the floorspec MCP tools, pre-approved.
    '--tools',
    '',
    '--allowedTools',
    ALLOWED_TOOLS.join(','),
    '--permission-mode',
    'dontAsk',
    '--append-system-prompt',
    designPartnerPrompt(),
    '--no-session-persistence',
    '--disable-slash-commands',
    ...(bare ? ['--bare'] : []),
    ...(options.model === undefined ? [] : ['--model', options.model]),
    ...(options.maxBudgetUsd === undefined ? [] : ['--max-budget-usd', String(options.maxBudgetUsd)]),
  ];
}

export async function runClaude(options: ClaudeOptions): Promise<AgentRun> {
  // An empty working directory: no CLAUDE.md, no repository for the agent to read.
  const dir = mkdtempSync(join(tmpdir(), 'floorspec-eval-'));
  const mcpConfig = join(dir, '.mcp-eval.json');
  writeFileSync(
    mcpConfig,
    JSON.stringify({ mcpServers: { [MCP_SERVER]: { command: process.execPath, args: [SHIM], env: { FLOORSPEC_URL: options.apiUrl, FLOORSPEC_TOKEN: options.token } } } }),
    { mode: 0o600 },
  );
  const env = childEnv();
  // With an API key, --bare: no hooks, plugins, memory or keychain — the same agent on every machine.
  const bare = typeof env['ANTHROPIC_API_KEY'] === 'string' && env['ANTHROPIC_API_KEY'].length > 0;
  const started = Date.now();
  const lines: string[] = [];
  let stderr = '';
  const state = { timedOut: false };
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(options.claudeBin ?? 'claude', claudeArgs(options, mcpConfig, bare), { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let buffer = '';
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let i: number;
        while ((i = buffer.indexOf('\n')) >= 0) {
          lines.push(buffer.slice(0, i));
          buffer = buffer.slice(i + 1);
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      const timer = setTimeout(() => {
        state.timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      }, options.timeoutMs);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (c) => {
        clearTimeout(timer);
        if (buffer.trim().length > 0) lines.push(buffer);
        resolve(c);
      });
    });
    const parsed = parseStream(lines);
    if (parsed.authError !== null) throw new AgentEnvironmentError(`claude could not authenticate: ${parsed.authError}. Set ANTHROPIC_API_KEY, or run \`claude auth login\`.`);
    if (parsed.mcpStatus !== null && parsed.mcpStatus !== 'connected') {
      throw new AgentEnvironmentError(`the floorspec MCP server did not connect (status ${parsed.mcpStatus}); stderr: ${stderr.slice(0, 1000)}`);
    }
    const error = parsed.resultError ?? (code !== 0 && !state.timedOut ? `claude exited ${String(code)}: ${stderr.slice(0, 1000)}` : undefined);
    return {
      reply: parsed.reply,
      calls: parsed.calls,
      turns: parsed.turns,
      costUsd: parsed.costUsd,
      wallMs: Date.now() - started,
      timedOut: state.timedOut,
      ...(error === undefined ? {} : { error }),
      transcript: lines.join('\n'),
    };
  } catch (error) {
    if (error instanceof AgentEnvironmentError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AgentEnvironmentError('the claude CLI is not on PATH: npm install -g @anthropic-ai/claude-code');
    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Parsed {
  reply: string;
  calls: ToolCall[];
  turns: number | null;
  costUsd: number | null;
  resultError: string | undefined;
  authError: string | null;
  mcpStatus: string | null;
}

type Block = { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; is_error?: boolean; content?: unknown };

/** Read a stream-json transcript: the tool calls with their outcomes, the final reply, the totals. */
export function parseStream(lines: readonly string[]): Parsed {
  const calls: ToolCall[] = [];
  const byId = new Map<string, ToolCall>();
  const texts: string[] = [];
  const out: Parsed = { reply: '', calls, turns: null, costUsd: null, resultError: undefined, authError: null, mcpStatus: null };
  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event['type'] === 'system' && event['subtype'] === 'init') {
      const servers = (event['mcp_servers'] as { name: string; status: string }[] | undefined) ?? [];
      out.mcpStatus = servers.find((s) => s.name === MCP_SERVER)?.status ?? 'missing';
    }
    const message = event['message'] as { content?: Block[] } | undefined;
    if (event['type'] === 'assistant' && Array.isArray(message?.content)) {
      for (const block of message.content) {
        if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
        if (block.type === 'tool_use' && typeof block.id === 'string') {
          const call: ToolCall = { id: block.id, name: (block.name ?? '').replace(`mcp__${MCP_SERVER}__`, ''), input: block.input ?? {} };
          calls.push(call);
          byId.set(block.id, call);
        }
      }
    }
    if (event['type'] === 'user' && Array.isArray(message?.content)) {
      for (const block of message.content) {
        if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const call = byId.get(block.tool_use_id);
        if (call === undefined) continue;
        call.isError = block.is_error === true;
        call.resultText = resultText(block.content);
      }
    }
    if (event['type'] === 'result') {
      if (typeof event['result'] === 'string') out.reply = event['result'];
      if (typeof event['num_turns'] === 'number') out.turns = event['num_turns'];
      if (typeof event['total_cost_usd'] === 'number') out.costUsd = event['total_cost_usd'];
      if (event['is_error'] === true) {
        const text = typeof event['result'] === 'string' ? event['result'] : typeof event['subtype'] === 'string' ? event['subtype'] : 'error';
        if (/authenticat|oauth|api key|login/i.test(text) && calls.length === 0) out.authError = text;
        else out.resultError = text;
      }
    }
  }
  if (out.reply === '' && texts.length > 0) out.reply = texts[texts.length - 1] ?? '';
  return out;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c: { type?: string; text?: string }) => (c.type === 'text' ? (c.text ?? '') : c.type === 'image' ? '[image]' : '')).join('\n');
  return '';
}

/** What a run did, from its tool calls: the numbers the report carries. */
export function callMetrics(calls: readonly ToolCall[]) {
  const writes = calls.filter((c) => c.name === 'floorspec_apply' || c.name === 'floorspec_propose');
  const batches = writes.filter((c) => Array.isArray(c.input['batch']));
  return {
    toolCalls: calls.length,
    byTool: Object.fromEntries([...new Set(calls.map((c) => c.name))].sort().map((n) => [n, calls.filter((c) => c.name === n).length])),
    batchesSent: batches.length,
    opsSent: batches.reduce((n, c) => n + (c.input['batch'] as unknown[]).length, 0),
    rejectedBatches: batches.filter((c) => c.isError === true && /^Rejected/.test(c.resultText ?? '')).length,
    otherToolErrors: calls.filter((c) => c.isError === true && !(/^Rejected/.test(c.resultText ?? '') && Array.isArray(c.input['batch']))).length,
    renderRequests: calls.filter((c) => c.name === 'floorspec_render').length + writes.filter((c) => c.input['render'] === true).length,
    rejections: batches
      .filter((c) => c.isError === true)
      .map((c) => (c.resultText ?? '').split('\n').slice(0, 6).join(' | ').slice(0, 600)),
  };
}

export type CallMetrics = ReturnType<typeof callMetrics>;
