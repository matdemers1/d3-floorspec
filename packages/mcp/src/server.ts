import { McpServer, ResourceTemplate, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { FloorspecApiError, type Committed, type FloorspecClient, type ProjectSummary } from './client.js';
import { Batch, Lock } from './ops-schema.js';
import { describeStub } from './describe.js';
import { query, QueryInput } from './query.js';
import { DESIGN_PARTNER_PROMPT } from './prompts.js';

/**
 * The D3 Floorspec MCP server (FLR-T-2.6): ten verbs over one operation vocabulary.
 *
 * Perception — describe, query, validate, findings, render, export — reads; action — apply,
 * propose, accept, reject — writes Floorspec Ops, nothing else (FLR-ADR-008). **There is no tool
 * that runs code** (FLR-REQ-058): an agent changes the house by sending typed operations, and a
 * test enumerates the tools to keep it that way.
 *
 * Handles are minted by the server: a project is its ID, a changeset its ID. The protocol is
 * stateless, so every call names (or defaults) its project.
 */

export const SERVER_NAME = 'd3-floorspec';
export const SERVER_VERSION = '0.1.0';

export const TOOL_NAMES = [
  'floorspec_describe',
  'floorspec_query',
  'floorspec_apply',
  'floorspec_propose',
  'floorspec_accept',
  'floorspec_reject',
  'floorspec_validate',
  'floorspec_findings',
  'floorspec_render',
  'floorspec_export',
] as const;

const ProjectHandle = z
  .string()
  .min(1)
  .max(64)
  .optional()
  .describe('The project handle (its ID). Optional when the credential reaches exactly one project.');
const ChangesetHandle = z.string().min(1).max(120);

export interface ServerOptions {
  readonly client: FloorspecClient;
}

function text(value: unknown): { type: 'text'; text: string } {
  return { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) };
}

function ok(summary: string, structured: Record<string, unknown>): CallToolResult {
  return { content: [text(summary), text(structured)], structuredContent: structured };
}

/** A refusal the agent can act on: what failed, and the diagnostics with their fix operations. */
function failure(error: unknown): CallToolResult {
  if (error instanceof FloorspecApiError) {
    const structured = { status: error.status, ...error.body };
    const diagnostics = error.diagnostics.map((d) => `- ${d.code} ${d.severity}: ${d.message}${d.elements.length > 0 ? ` [${d.elements.join(', ')}]` : ''}`);
    const lead =
      error.status === 422
        ? 'Rejected: nothing changed.'
        : error.status === 409 && error.body['type'] === '/problems/replay-failed'
          ? 'Not merged: the changeset no longer applies to main, and it is still pending.'
          : `Refused (${String(error.status)}).`;
    return {
      isError: true,
      content: [text([`${lead} ${error.message}`, ...diagnostics].join('\n')), text(structured)],
      structuredContent: structured,
    };
  }
  if (error instanceof ToolError) return { isError: true, content: [text(error.message)] };
  throw error;
}

class ToolError extends Error {}

async function resolveProject(client: FloorspecClient, handle: string | undefined): Promise<ProjectSummary> {
  const projects = await client.listProjects();
  if (handle !== undefined) {
    const found = projects.find((p) => p.id === handle) ?? projects.filter((p) => p.name.toLowerCase() === handle.toLowerCase()).at(0);
    if (found === undefined) throw new ToolError(`No project "${handle}" is reachable with this credential.`);
    return found;
  }
  if (projects.length === 1 && projects[0] !== undefined) return projects[0];
  if (projects.length === 0) throw new ToolError('This credential reaches no projects. Create one in D3 Floorspec first.');
  throw new ToolError(`Name a project: ${projects.map((p) => `${p.name} (${p.id})`).join(', ')}.`);
}

/** How an apply landed, in words an agent cannot misread. */
function landed(result: Committed): string {
  const where =
    result.changeset === null
      ? `Committed to main as op ${String(result.op.seq)}.`
      : `Proposed into changeset "${result.changeset.name}" (${result.changeset.id}) as op ${String(result.op.seq)}. It is pending: main has not changed until a person accepts it.`;
  const changes = [
    result.created.length > 0 ? `created ${result.created.join(', ')}` : '',
    result.removed.length > 0 ? `removed ${result.removed.join(', ')}` : '',
  ].filter((s) => s.length > 0);
  return `${where} New version ${result.hash}.${changes.length > 0 ? ` It ${changes.join('; ')}.` : ''}`;
}

async function renderContent(client: FloorspecClient, projectId: string, options: { level?: string; changeset?: string }) {
  try {
    const png = await client.render(projectId, { view: 'plan', ...options });
    return [{ type: 'image' as const, data: Buffer.from(png).toString('base64'), mimeType: 'image/png' }];
  } catch (error) {
    if (error instanceof FloorspecApiError) {
      return [text(`No render: ${error.message}. You have not seen the result — say so rather than describing it.`)];
    }
    throw error;
  }
}

export function createFloorspecServer({ client }: ServerOptions): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Design a house as code. Read with floorspec_describe before editing; edit with typed Floorspec Ops ' +
        '(references like "north wall of Kitchen", lengths like 12\' 6"); render and validate after every change. ' +
        'Agent edits land in a pending changeset a person accepts. Never claim a change without a committed result and a render.',
    },
  );

  server.registerTool(
    'floorspec_describe',
    {
      title: 'Describe the house',
      description:
        'A room-centric summary of the model: rooms with their sizes and areas, levels, and open diagnostics. Read this first, before any edit.',
      inputSchema: z.strictObject({
        project: ProjectHandle,
        changeset: ChangesetHandle.optional().describe('Describe a pending changeset instead of main.'),
        level: z.string().min(1).max(64).optional().describe('Only this level.'),
        room: z.string().min(1).max(200).optional().describe('Only this room (ID or name).'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const project = await resolveProject(client, args.project);
        const model = await client.model(project.id, args.changeset);
        const summary = describeStub(model.document, {
          ...(args.level === undefined ? {} : { level: args.level }),
          ...(args.room === undefined ? {} : { room: args.room }),
        });
        return ok(`${project.name} at ${model.hash}${args.changeset === undefined ? ' (main)' : ` (changeset ${args.changeset})`}.`, {
          project: project.id,
          hash: model.hash,
          ...summary,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'floorspec_query',
    {
      title: 'Query elements',
      description:
        'Elements by ID, kind, level, room or relationship, with geometry resolved in feet-inches and base units: the walls bounding a room, the openings in a wall, the rooms either side of a wall.',
      inputSchema: z.strictObject({ project: ProjectHandle, changeset: ChangesetHandle.optional(), ...QueryInput }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ project: handle, changeset, ...args }) => {
      try {
        const project = await resolveProject(client, handle);
        const model = await client.model(project.id, changeset);
        const result = query(model.document, args);
        return ok(`${String(result.count)} element(s) at ${model.hash}.${result.notes.length > 0 ? ` ${result.notes.join(' ')}` : ''}`, {
          project: project.id,
          hash: model.hash,
          ...result,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'floorspec_apply',
    {
      title: 'Apply operations',
      description:
        'Apply a batch of typed Floorspec Ops as one transaction: all commit or none. A person\'s write token commits to main; ' +
        'an agent credential writes into a pending changeset (named by `changeset`, or after the credential). ' +
        'A rejection changes nothing and returns diagnostics with fix operations. Ask for render: true and look at it.',
      inputSchema: z.strictObject({
        project: ProjectHandle,
        batch: Batch,
        locks: z.array(Lock).max(200).optional(),
        changeset: ChangesetHandle.optional().describe('A changeset handle, or a name to open or append to.'),
        ifMatch: z.string().regex(/^[0-9a-f]{64}$/).optional().describe('Apply only if the head is still at this version hash.'),
        render: z.boolean().optional().describe('Also return a plan render of the result.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const project = await resolveProject(client, args.project);
        const result = await client.apply(project.id, {
          batch: args.batch,
          ...(args.locks === undefined ? {} : { locks: args.locks }),
          ...(args.changeset === undefined ? {} : { changeset: args.changeset }),
          ...(args.ifMatch === undefined ? {} : { ifMatch: args.ifMatch }),
        });
        const structured = { project: project.id, ...result };
        const content: CallToolResult['content'] = [text(landed(result)), text(structured)];
        if (args.render === true) {
          content.push(...(await renderContent(client, project.id, result.changeset === null ? {} : { changeset: result.changeset.id })));
        }
        return { content, structuredContent: structured };
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'floorspec_propose',
    {
      title: 'Propose a changeset',
      description:
        'Open a named changeset (or add to the pending one of that name) with an optional batch. Main does not change; a person reviews and accepts or rejects it. Returns the changeset handle.',
      inputSchema: z.strictObject({
        project: ProjectHandle,
        name: z.string().trim().min(1).max(120).describe('What the change is, for the person reviewing it: "Widen the kitchen 2 ft".'),
        batch: Batch.optional(),
        locks: z.array(Lock).max(200).optional(),
        render: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const project = await resolveProject(client, args.project);
        const result = await client.propose(project.id, {
          name: args.name,
          ...(args.batch === undefined ? {} : { batch: args.batch }),
          ...(args.locks === undefined ? {} : { locks: args.locks }),
        });
        const structured = { project: project.id, ...result };
        const content: CallToolResult['content'] = [
          text(
            `Changeset "${result.changeset.name}" (${result.changeset.id}) is pending${result.applied === null ? '' : `; ${landed(result.applied)}`}`,
          ),
          text(structured),
        ];
        if (args.render === true) content.push(...(await renderContent(client, project.id, { changeset: result.changeset.id })));
        return { content, structuredContent: structured };
      } catch (error) {
        return failure(error);
      }
    },
  );

  for (const verb of ['accept', 'reject'] as const) {
    server.registerTool(
      `floorspec_${verb}`,
      {
        title: verb === 'accept' ? 'Accept a changeset' : 'Reject a changeset',
        description:
          verb === 'accept'
            ? 'Merge a pending changeset into main: a fast-forward when main has not moved, otherwise a replay of its batches onto main; a replay that no longer applies is refused with diagnostics. A person\'s decision: agent credentials are refused.'
            : 'Discard a pending changeset. A person\'s decision: agent credentials are refused.',
        inputSchema: z.strictObject({ project: ProjectHandle, changeset: ChangesetHandle.describe('The changeset handle (its ID).') }),
        annotations: { readOnlyHint: false, destructiveHint: verb === 'reject', openWorldHint: false },
      },
      async (args) => {
        try {
          const project = await resolveProject(client, args.project);
          if (verb === 'accept') {
            const result = await client.accept(project.id, args.changeset);
            return ok(`Accepted "${result.changeset.name}" by ${result.mode}; main is at ${result.hash}.`, { project: project.id, ...result });
          }
          const result = await client.reject(project.id, args.changeset);
          return ok(`Rejected "${result.changeset.name}"; main is unchanged.`, { project: project.id, ...result });
        } catch (error) {
          return failure(error);
        }
      },
    );
  }

  server.registerTool(
    'floorspec_validate',
    {
      title: 'Validate',
      description: 'Schema, invariant and lint diagnostics for main or a pending changeset, from the reference engine.',
      inputSchema: z.strictObject({ project: ProjectHandle, changeset: ChangesetHandle.optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const project = await resolveProject(client, args.project);
        const result = await client.validate(project.id, args.changeset);
        const errors = result.diagnostics.filter((d) => d.severity === 'error').length;
        return ok(`${result.valid ? 'Valid' : 'Not valid'}: ${String(errors)} error(s), ${String(result.diagnostics.length - errors)} other diagnostic(s).`, {
          project: project.id,
          ...result,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'floorspec_findings',
    {
      title: 'Advisory findings',
      description:
        'Advisory code findings with citations, for main or a pending changeset. Findings advise and never block; nothing here means a design is compliant.',
      inputSchema: z.strictObject({
        project: ProjectHandle,
        changeset: ChangesetHandle.optional(),
        profile: z.string().min(1).max(64).optional().describe('A jurisdiction profile, once rule packs are installed.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const project = await resolveProject(client, args.project);
        const result = await client.findings(project.id, args.changeset);
        return ok(`${String(result.findings.length)} finding(s). ${result.note}`, { project: project.id, ...result });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'floorspec_render',
    {
      title: 'Render',
      description: 'A PNG of a level\'s plan, for main or a pending changeset. Look at it before describing a change. 3D is not available yet.',
      inputSchema: z.strictObject({
        project: ProjectHandle,
        changeset: ChangesetHandle.optional(),
        view: z.enum(['plan', '3d']).optional().describe('"plan" (default) or "3d" (not available yet).'),
        level: z.string().min(1).max(64).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const project = await resolveProject(client, args.project);
        const png = await client.render(project.id, {
          view: args.view ?? 'plan',
          ...(args.level === undefined ? {} : { level: args.level }),
          ...(args.changeset === undefined ? {} : { changeset: args.changeset }),
        });
        return { content: [{ type: 'image', data: Buffer.from(png).toString('base64'), mimeType: 'image/png' }] };
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'floorspec_export',
    {
      title: 'Export',
      description: 'Export the model. Format "floorspec": the canonical Floorspec Core JSON. Other formats come later.',
      inputSchema: z.strictObject({ project: ProjectHandle, changeset: ChangesetHandle.optional(), format: z.enum(['floorspec']).optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const project = await resolveProject(client, args.project);
        const model = await client.model(project.id, args.changeset);
        const uri = modelUri(project.id, args.changeset);
        return {
          content: [
            text(`Canonical Floorspec JSON for ${project.name} at ${model.hash}.`),
            { type: 'resource_link', uri, name: 'model.json', mimeType: 'application/json' },
            { type: 'resource', resource: { uri, mimeType: 'application/json', text: model.text } },
          ],
        };
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerResource(
    'model',
    new ResourceTemplate('floorspec://{project}/model', {
      list: async () => ({
        resources: (await client.listProjects()).map((p) => ({ uri: modelUri(p.id), name: `${p.name} — model.json`, mimeType: 'application/json' })),
      }),
    }),
    { title: 'A project\'s model', description: 'The canonical Floorspec JSON at main.', mimeType: 'application/json' },
    async (uri, variables) => {
      const project = String(variables['project']);
      const model = await client.model(project);
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: model.text }] };
    },
  );

  server.registerPrompt(
    'design-partner',
    { title: 'Design partner', description: 'How to work on a house with these tools: read, propose, render, check, never claim without a render.' },
    () => ({ messages: [{ role: 'user', content: { type: 'text', text: DESIGN_PARTNER_PROMPT } }] }),
  );

  return server;
}

export function modelUri(projectId: string, changeset?: string): string {
  return changeset === undefined ? `floorspec://${projectId}/model` : `floorspec://${projectId}/model?changeset=${encodeURIComponent(changeset)}`;
}
