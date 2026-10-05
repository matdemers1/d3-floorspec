import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { SHIM } from './api.js';
import type { AgentRun, ToolCall } from './agent.js';
import type { Task } from './types.js';

/**
 * The scripted agent: plays a task's first reference solution through the **same path Claude
 * uses** — the stdio shim, the agent token, the MCP tools, a pending changeset — so the harness can
 * be proved end to end without a model. Its pass rate measures the harness, never Claude; the
 * report says which agent ran.
 */
export async function runReference(task: Task, apiUrl: string, token: string): Promise<AgentRun> {
  const started = Date.now();
  const calls: ToolCall[] = [];
  const client = new Client({ name: 'floorspec-agent-eval-reference', version: '0.1.0' });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [SHIM], env: { FLOORSPEC_URL: apiUrl, FLOORSPEC_TOKEN: token, PATH: process.env['PATH'] ?? '' } }),
  );
  const call = async (name: string, input: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: input });
    const text = ((result.content) as { type: string; text?: string }[]).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
    calls.push({ id: String(calls.length), name, input, isError: result.isError === true, resultText: text });
    return result;
  };
  try {
    await call('floorspec_describe', {});
    const ref = task.references[0];
    const batches = ref?.batches ?? [];
    for (const [i, batch] of batches.entries()) {
      const result = await call('floorspec_apply', { batch, render: i === batches.length - 1 });
      if (result.isError === true) break;
    }
    return { reply: ref?.reply ?? 'Done: the change is in a pending changeset for you to accept.', calls, turns: null, costUsd: null, wallMs: Date.now() - started, timedOut: false, transcript: JSON.stringify(calls, null, 2) };
  } finally {
    await client.close().catch(() => undefined);
  }
}
