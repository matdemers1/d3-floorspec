/**
 * A FloorspecClient whose main head is a document in memory, edited by the reference applier as the
 * API runs it — Ops 0.2, implementing and knowing the four official extensions — and the
 * in-process MCP server connected to it. Shared by the tool-path tests.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { canonicalize, contentHash, OFFICIAL_READER } from '@floorspec/engine';
import { apply } from '@floorspec/ops';
import { createFloorspecMcpHandler, FloorspecApiError, type ApplyInput, type Committed, type FloorspecClient, type ProjectSummary, type Validation } from '../src/index.js';

export const PROJECT = '01a10000-0000-7000-8000-000000000001';

/** A client whose main head is a document in memory, edited by the reference applier. */
export class ApplierClient implements FloorspecClient {
  document: object;
  seq = 1;
  constructor(document: object) {
    this.document = document;
  }
  listProjects() {
    return Promise.resolve([{ id: PROJECT, name: 'Lake house', head: contentHash(this.document) }]);
  }
  createProject(_name: string): Promise<ProjectSummary> {
    return Promise.reject(new Error('the applier client holds one project'));
  }
  model() {
    return Promise.resolve({ hash: contentHash(this.document), document: this.document, text: canonicalize(this.document) });
  }
  apply(_projectId: string, input: ApplyInput): Promise<Committed> {
    const before = contentHash(this.document);
    const r = apply(this.document, { batch: input.batch as never }, { ops: '0.4', ...OFFICIAL_READER });
    if (r.status === 'rejected')
      return Promise.reject(new FloorspecApiError(422, { type: '/problems/ops-rejected', error: 'the batch was rejected and nothing changed', diagnostics: r.diagnostics }));
    this.document = JSON.parse(r.document) as object;
    this.seq++;
    return Promise.resolve({ status: 'committed', head: 'main', before, hash: r.hash, op: { id: `op-${String(this.seq)}`, seq: this.seq, kind: 'apply' }, resolved: r.resolved as unknown as Committed['resolved'], created: r.created, removed: r.removed, changeset: null });
  }
  propose(): never {
    throw new Error('not used');
  }
  changesets() {
    return Promise.resolve([]);
  }
  accept(): never {
    throw new Error('not used');
  }
  reject(): never {
    throw new Error('not used');
  }
  proposeLayouts(): never {
    throw new Error('not used');
  }
  proposeElectrical(): never {
    throw new Error('not used');
  }
  validate(): Promise<Validation> {
    return Promise.resolve({ head: 'main', hash: contentHash(this.document), valid: true, diagnostics: [] });
  }
  findings() {
    return Promise.resolve({ head: 'main', hash: contentHash(this.document), findings: [], rulePacks: [], note: '' });
  }
  render(): Promise<Uint8Array> {
    return Promise.reject(new FloorspecApiError(501, { error: 'no renderer here' }));
  }
}

export async function connect(client: FloorspecClient) {
  const handler = createFloorspecMcpHandler(() => client);
  const fetchLike = (url: string | URL, init?: RequestInit) => handler.fetch(new Request(url, init));
  const mcp = new Client({ name: 'test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await mcp.connect(new StreamableHTTPClientTransport(new URL('http://floorspec.test/mcp'), { fetch: fetchLike }));
  return mcp;
}

