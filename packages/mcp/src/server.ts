import { McpServer, ResourceTemplate, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { FloorspecApiError, type Committed, type FloorspecClient, type Layouts, type ProjectSummary, type RenderOptions } from './client.js';
import { Batch, Lock, OP_BY_NAME_ONLY } from './ops-schema.js';
import { hintsFor } from './hints.js';
import { compactSchema } from './tool-schema.js';
import { describe, describeJson } from './summary/index.js';
import { query, QueryInput } from './query.js';
import { findRoom } from './model.js';
import { DESIGN_PARTNER_PROMPT } from './prompts.js';

/**
 * The D3 Floorspec MCP server (FLR-T-2.6): eleven verbs over one operation vocabulary.
 *
 * Perception — describe, query, validate, findings, render, export — reads; action — apply,
 * propose (a batch, or the electrical assistant's), propose_layouts, accept, reject — writes
 * Floorspec Ops, nothing else (FLR-ADR-008). **There is no tool
 * that runs code** (FLR-REQ-058): an agent changes the house by sending typed operations, and a
 * test enumerates the tools to keep it that way.
 *
 * Handles are minted by the server: a project is its ID, a changeset its ID — and every tool that
 * takes a changeset takes its name as well, since names are unique among a project's pending
 * changesets. The protocol is stateless, so every call names (or defaults) its project.
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
  'floorspec_propose_layouts',
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
  .describe('Project ID or name; optional if the credential reaches one.');
const ChangesetHandle = z.string().min(1).max(120);
/** A changeset to read: by name or ID, exactly as floorspec_apply takes one. */
const PendingChangeset = ChangesetHandle.optional().describe("A pending changeset's name or ID; omitted, main.");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ServerOptions {
  readonly client: FloorspecClient;
}

function text(value: unknown): { type: 'text'; text: string } {
  return { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) };
}

function ok(summary: string, structured: Record<string, unknown>): CallToolResult {
  return { content: [text(summary), text(structured)], structuredContent: structured };
}

/**
 * A refusal the agent can act on: what failed, the diagnostics with their fix operations, and — for
 * the mistakes agents are known to make — a one-line hint with the fix. The coded diagnostics are
 * passed on unchanged; a hint is only ever extra text.
 */
function failure(error: unknown, batch?: readonly { op: string }[]): CallToolResult {
  if (error instanceof FloorspecApiError) {
    const structured = { status: error.status, ...error.body };
    const diagnostics = [
      ...error.diagnostics.map((d) => `- ${d.code} ${d.severity}: ${d.message}${d.elements.length > 0 ? ` [${d.elements.join(', ')}]` : ''}`),
      ...hintsFor(error.diagnostics, batch).map((h) => `Hint: ${h}`),
    ];
    const lead =
      error.status === 422
        ? 'Rejected: nothing changed.'
        : error.status === 409 && error.body['type'] === '/problems/replay-failed'
          ? 'Not merged: the changeset no longer applies to main, and it is still pending.'
          : `Refused (${String(error.status)}).`;
    return {
      isError: true,
      // A problem without diagnostics says why in its detail: "there is no program to lay out".
      content: [text([`${lead} ${error.message}${diagnostics.length === 0 && typeof error.body['detail'] === 'string' ? `: ${error.body['detail']}` : ''}`, ...diagnostics].join('\n')), text(structured)],
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

/**
 * A changeset handle as the API takes it — its ID — from what the agent gave: an ID, or the name
 * of a pending changeset (unique among the project's pending ones), matched exactly and then
 * ignoring case. An ID is passed through untouched for the API to judge.
 */
async function resolveChangeset(client: FloorspecClient, projectId: string, handle: string): Promise<{ id: string; name?: string }> {
  const trimmed = handle.trim();
  if (UUID.test(trimmed)) return { id: trimmed.toLowerCase() };
  const pending = (await client.changesets(projectId)).filter((c) => c.status === 'pending');
  const found =
    pending.find((c) => c.name === trimmed) ?? (pending.filter((c) => c.name.toLowerCase() === trimmed.toLowerCase()).length === 1 ? pending.find((c) => c.name.toLowerCase() === trimmed.toLowerCase()) : undefined);
  if (found !== undefined) return { id: found.id, name: found.name };
  throw new ToolError(
    pending.length === 0
      ? `No pending changeset is named "${trimmed}": this project has no pending changesets.`
      : `No pending changeset is named "${trimmed}". Pending: ${pending.map((c) => `"${c.name}" (${c.id})`).join(', ')}.`,
  );
}

/** resolveChangeset for an optional argument: undefined is main. */
async function changesetId(client: FloorspecClient, projectId: string, handle: string | undefined): Promise<string | undefined> {
  return handle === undefined ? undefined : (await resolveChangeset(client, projectId, handle)).id;
}

/** How an apply landed, in words an agent cannot misread. */
function landed(result: Committed): string {
  const where =
    result.changeset === null || result.changeset === undefined
      ? `Committed to main as op ${String(result.op.seq)}.`
      : `Proposed into changeset "${result.changeset.name}" (${result.changeset.id}) as op ${String(result.op.seq)}. It is pending: main has not changed until a person accepts it.`;
  const changes = [
    result.created.length > 0 ? `created ${result.created.join(', ')}` : '',
    result.removed.length > 0 ? `removed ${result.removed.join(', ')}` : '',
  ].filter((s) => s.length > 0);
  return `${where} New version ${result.hash}.${changes.length > 0 ? ` It ${changes.join('; ')}.` : ''}${emptyOpenings(result)}`;
}

/**
 * A note on every opening the batch created without a `fill`: an empty cased opening, not a door or
 * window — what an agent asked for "a 32-inch door" made when no type of that size existed. Read
 * from the resolved echo, so it names exactly what the batch added.
 */
export function emptyOpenings(result: Pick<Committed, 'resolved' | 'created'>): string {
  const ids = result.resolved
    .filter((p) => {
      const element = p['element'];
      return p.op === 'addElement' && p['collection'] === 'openings' && typeof p['id'] === 'string' && result.created.includes(p['id']) && element !== null && typeof element === 'object' && !('fill' in element);
    })
    .map((p) => p['id'] as string);
  if (ids.length === 0) return '';
  const [first] = ids;
  return (
    ` Note: ${ids.join(', ')} ${ids.length === 1 ? 'is an empty cased opening' : 'are empty cased openings'} — no fill, so no door or window. ` +
    `If a door or window was meant, set its fill to the nearest doorType or windowType ({"op":"setProperty","id":"${String(first)}","path":"/fill","value":"<type>"}) and keep its width and height, which override the type's.`
  );
}

const pct = (x: number): string => `${String(Math.round(x * 100))}%`;

/** The candidates in words: each changeset, its scores, and what the solver says of it. */
export function layoutsText(result: Layouts): string {
  const lines = [
    `${String(result.candidates.length)} layout candidates from ${String(result.solved.items)} brief items and ${String(result.solved.adjacencies)} adjacencies, each a pending changeset; main has not changed until a person accepts one, and accepting one stops the others applying.`,
  ];
  for (const c of result.candidates) {
    lines.push(
      '',
      `${String(c.rank)}. "${c.changeset.name}" (${c.changeset.id})${c.reused ? ', already open' : ''}: score ${c.score.total.toFixed(1)} — brief fit ${pct(c.score.briefFit)}, circulation ${pct(c.score.circulation)}, findings ${pct(c.score.findings)}.`,
      ...c.explanation.map((line) => `   - ${line}`),
      ...(c.unplaced.length > 0 ? [`   - not placed here: ${c.unplaced.map((u) => `${u.item} x${String(u.count)} (${u.reason})`).join('; ')}`] : []),
    );
  }
  return lines.join('\n');
}

async function renderContent(client: FloorspecClient, projectId: string, options: Omit<RenderOptions, 'view'>) {
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
        'Design a house as code. Read with floorspec_describe before editing; edit with floorspec_apply, whose `batch` is a list of typed Floorspec Ops ' +
        '(references like "north wall of Kitchen", lengths like 12\' 6"), the brief (addProgramItem, setAdjacency, setRoomBrief) and devices — receptacles, panels, fixtures, equipment (placeElement; the first of an extension declares it in extensionsUsed) — included; ' +
        'render and validate after every change. ' +
        'Agent edits land in a pending changeset a person accepts; every tool takes a changeset by name or ID. ' +
        'The design-partner prompt has the working rules and example calls. Never claim a change without a committed result and a render.',
    },
  );

  server.registerTool(
    'floorspec_describe',
    {
      title: 'Describe the house',
      description:
        'A room-centric summary: rooms with ft-in sizes and net areas, walls by side with their openings, adjacency, the door graph, roofs, stairs, diagnostics and the room functions. Read it before any edit.',
      inputSchema: compactSchema(
        z.strictObject({
          project: ProjectHandle,
          changeset: PendingChangeset,
          level: z.string().min(1).max(64).optional().describe('Only this level.'),
          room: z.string().min(1).max(200).optional().describe('Only this room (ID or name).'),
        }),
      ),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const project = await resolveProject(client, args.project);
        const changeset = args.changeset === undefined ? undefined : await resolveChangeset(client, project.id, args.changeset);
        const model = await client.model(project.id, changeset?.id);
        // The room may be named, as the schema says, not only given by ID.
        let room: string | undefined;
        if (args.room !== undefined) {
          const found = findRoom(model.document as Record<string, unknown>, args.room);
          if (found === null) throw new ToolError(`No room is called "${args.room}", or more than one is: use its ID (floorspec_describe without "room" lists them).`);
          room = found[0];
        }
        if (args.level !== undefined && !Object.hasOwn((model.document as { levels?: object }).levels ?? {}, args.level)) {
          throw new ToolError(`There is no level "${args.level}": use a level ID (floorspec_describe without "level" lists them).`);
        }
        const options = {
          ...(args.level === undefined ? {} : { level: args.level }),
          ...(room === undefined ? {} : { room }),
        };
        const where = `${project.name} at ${model.hash}${changeset === undefined ? ' (main)' : ` (changeset ${changeset.name === undefined ? '' : `"${changeset.name}" `}${changeset.id}, pending)`}`;
        const summary = describeJson(model.document as object, options);
        return {
          content: [text(`${where}\n\n${describe(model.document as object, options)}`)],
          structuredContent: { project: project.id, hash: model.hash, ...(changeset === undefined ? {} : { changeset: changeset.id }), summary },
        };
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
        'Elements by ID, kind, level, room or relationship, with geometry in ft-in and base units: the walls bounding a room, the openings in a wall, the rooms either side of a wall.',
      inputSchema: compactSchema(z.strictObject({ project: ProjectHandle, changeset: PendingChangeset, ...QueryInput })),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ project: handle, changeset, ...args }) => {
      try {
        const project = await resolveProject(client, handle);
        const model = await client.model(project.id, await changesetId(client, project.id, changeset));
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
        'Apply `batch`, a list of typed Floorspec Ops, as one transaction: all commit or none. ' +
        'Example: {"changeset":"Widen the kitchen","batch":[{"op":"resizeRoom","room":"Kitchen","side":"east","by":"2\'"}],"render":true}. ' +
        'A write token commits to main; an agent credential writes into a pending changeset (`changeset`, or one named after the credential). ' +
        'A rejection changes nothing and returns diagnostics with fix operations.',
      inputSchema: compactSchema(
        z.strictObject({
          project: ProjectHandle,
          batch: Batch,
          locks: z.array(Lock).max(200).optional(),
          changeset: ChangesetHandle.optional().describe('A changeset\'s name or ID; a new name opens one.'),
          ifMatch: z.string().regex(/^[0-9a-f]{64}$/).optional().describe('Apply only if the head is still at this version hash.'),
          render: z.boolean().optional().describe('Also return a plan render; look at it.'),
        }),
      ),
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
          // What the batch created is drawn in the accent; a changeset is drawn ghosted against its base.
          content.push(
            ...(await renderContent(client, project.id, {
              highlight: result.created,
              ...(result.changeset === null || result.changeset === undefined ? {} : { changeset: result.changeset.id }),
            })),
          );
        }
        return { content, structuredContent: structured };
      } catch (error) {
        return failure(error, args.batch);
      }
    },
  );

  server.registerTool(
    'floorspec_propose',
    {
      title: 'Propose a changeset',
      description:
        'Open a named changeset (or add to the pending one of that name), with an optional batch as floorspec_apply takes; or let assistant "electrical" propose receptacles, switches, lights and circuits. Main does not change; a person accepts or rejects it.',
      inputSchema: compactSchema(
        z.strictObject({
          project: ProjectHandle,
          name: z.string().trim().min(1).max(120).optional().describe('What the change is, for the reviewer: "Widen the kitchen 2 ft". Not for an assistant.'),
          batch: Batch.optional(),
          locks: z.array(Lock).max(200).optional(),
          assistant: z.enum(['electrical']).optional(),
          rooms: z.array(z.string().min(1).max(200)).max(200).optional().describe('The assistant\'s rooms; default all.'),
          render: z.boolean().optional(),
        }),
        // The union is spelled out once, on floorspec_apply; the batch is validated the same here.
        { advertise: { Op: OP_BY_NAME_ONLY } },
      ),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const project = await resolveProject(client, args.project);
        if (args.assistant === 'electrical') {
          if (args.batch !== undefined) throw new ToolError('Send either a batch or an assistant, not both.');
          const result = await client.proposeElectrical(project.id, args.rooms === undefined ? {} : { rooms: args.rooms });
          const structured = { project: project.id, ...result };
          const lead =
            result.changeset === null
              ? 'Nothing proposed: main is unchanged.'
              : `Changeset "${result.changeset.name}" (${result.changeset.id}) is pending: ${String(result.proposal.ops)} operations from the electrical assistant. Main has not changed until a person accepts it.`;
          const content: CallToolResult['content'] = [text([lead, ...result.proposal.explanation.map((l) => `- ${l}`)].join('\n')), text(structured)];
          if (args.render === true && result.changeset !== null) {
            const created = [...result.proposal.added.receptacles, ...result.proposal.added.switches, ...result.proposal.added.lights];
            content.push(...(await renderContent(client, project.id, { changeset: result.changeset.id, highlight: created })));
          }
          return { content, structuredContent: structured };
        }
        if (args.name === undefined) throw new ToolError('Name the changeset: "name" says what the change is, for the reviewer.');
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
        if (args.render === true) {
          content.push(...(await renderContent(client, project.id, { changeset: result.changeset.id, highlight: result.applied?.created ?? [] })));
        }
        return { content, structuredContent: structured };
      } catch (error) {
        return failure(error, args.batch);
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
            ? 'Merge a pending changeset into main (fast-forward, or a replay refused with diagnostics if it no longer applies). A person\'s decision: agent credentials are refused.'
            : 'Discard a pending changeset. A person\'s decision: agent credentials are refused.',
        inputSchema: compactSchema(z.strictObject({ project: ProjectHandle, changeset: ChangesetHandle.describe("The pending changeset's name or ID.") })),
        annotations: { readOnlyHint: false, destructiveHint: verb === 'reject', openWorldHint: false },
      },
      async (args) => {
        try {
          const project = await resolveProject(client, args.project);
          const changeset = (await resolveChangeset(client, project.id, args.changeset)).id;
          if (verb === 'accept') {
            const result = await client.accept(project.id, changeset);
            return ok(`Accepted "${result.changeset.name}" by ${result.mode}; main is at ${result.hash}.`, { project: project.id, ...result });
          }
          const result = await client.reject(project.id, changeset);
          return ok(`Rejected "${result.changeset.name}"; main is unchanged.`, { project: project.id, ...result });
        } catch (error) {
          return failure(error);
        }
      },
    );
  }

  server.registerTool(
    'floorspec_propose_layouts',
    {
      title: 'Propose layouts',
      description:
        'Lay out main\'s brief (its program and adjacencies) as ranked candidate plans, each opened as a pending changeset for a person to compare and accept. Lays out on an empty level, or adds one. Read the reports, then render a changeset to look at it.',
      inputSchema: compactSchema(
        z.strictObject({
          project: ProjectHandle,
          level: z.string().min(1).max(64).optional().describe('An empty level to lay out on.'),
          footprint: z
            .strictObject({ width: z.union([z.int().min(1), z.string().min(1).max(64)]), depth: z.union([z.int().min(1), z.string().min(1).max(64)]) })
            .optional()
            .describe('East–west width and north–south depth, e.g. "44\'"; default sized from the brief.'),
          count: z.int().min(3).max(6).optional().describe('Candidates; default 3.'),
        }),
      ),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const project = await resolveProject(client, args.project);
        const result = await client.proposeLayouts(project.id, {
          ...(args.level === undefined ? {} : { level: args.level }),
          ...(args.footprint === undefined ? {} : { footprint: args.footprint }),
          ...(args.count === undefined ? {} : { count: args.count }),
        });
        return ok(layoutsText(result), { project: project.id, ...result });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'floorspec_validate',
    {
      title: 'Validate',
      description: 'Schema, invariant and lint diagnostics for main or a pending changeset, from the reference engine.',
      inputSchema: compactSchema(z.strictObject({ project: ProjectHandle, changeset: PendingChangeset })),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const project = await resolveProject(client, args.project);
        const result = await client.validate(project.id, await changesetId(client, project.id, args.changeset));
        const errors = result.diagnostics.filter((d) => d.severity === 'error').length;
        const hints = hintsFor(result.diagnostics).map((h) => ` Hint: ${h}`).join('');
        return ok(`${result.valid ? 'Valid' : 'Not valid'}: ${String(errors)} error(s), ${String(result.diagnostics.length - errors)} other diagnostic(s).${hints}`, {
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
      inputSchema: compactSchema(
        z.strictObject({
          project: ProjectHandle,
          changeset: PendingChangeset,
          profile: z.string().min(1).max(64).optional().describe('A jurisdiction profile, once rule packs are installed.'),
        }),
      ),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const project = await resolveProject(client, args.project);
        const result = await client.findings(project.id, await changesetId(client, project.id, args.changeset));
        // Each finding's message names its subject, the rule and the edition it was checked against.
        const lines = result.findings.slice(0, 50).map((f) => `- ${f.message}`);
        if (result.findings.length > lines.length) lines.push(`- …and ${String(result.findings.length - lines.length)} more in structuredContent.`);
        return ok([`${String(result.findings.length)} finding(s). ${result.note}`, ...lines].join('\n'), { project: project.id, ...result });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'floorspec_render',
    {
      title: 'Render',
      description:
        'A PNG of a level\'s plan, for main or a pending changeset (drawn ghosted against its base). Look at it before describing a change. 3D is not available yet.',
      inputSchema: compactSchema(
        z.strictObject({
          project: ProjectHandle,
          changeset: PendingChangeset,
          view: z.enum(['plan', '3d']).optional().describe('"plan" (default); "3d" is not available yet.'),
          level: z.string().min(1).max(64).optional().describe('The level to draw; default the lowest.'),
          highlight: z.array(z.string().min(1).max(64)).max(100).optional().describe('Element IDs to draw in the accent colour.'),
          width: z.int().min(256).max(4096).optional().describe('Pixels wide; default the natural size.'),
        }),
      ),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const project = await resolveProject(client, args.project);
        const changeset = await changesetId(client, project.id, args.changeset);
        const png = await client.render(project.id, {
          view: args.view ?? 'plan',
          ...(args.level === undefined ? {} : { level: args.level }),
          ...(changeset === undefined ? {} : { changeset }),
          ...(args.highlight === undefined ? {} : { highlight: args.highlight }),
          ...(args.width === undefined ? {} : { width: args.width }),
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
      inputSchema: compactSchema(z.strictObject({ project: ProjectHandle, changeset: PendingChangeset, format: z.enum(['floorspec']).optional() })),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const project = await resolveProject(client, args.project);
        const changeset = await changesetId(client, project.id, args.changeset);
        const model = await client.model(project.id, changeset);
        const uri = modelUri(project.id, changeset);
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
