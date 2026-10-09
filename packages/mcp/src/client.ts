/**
 * How the MCP tools reach D3 Floorspec: through its REST API, with the caller's own credential.
 *
 * The remote `/mcp` endpoint hands each request a client that loops back to the API carrying the
 * bearer token the MCP request arrived with — not exchanged, not upgraded. Every tool call
 * therefore passes the same guards, the same isolation and the same audit as the REST API, and
 * there is no second authorisation surface for a check to be missing from. (Foreman's pattern.)
 */

/** A Floorspec Op as the tools send it; the applier is the judge of its members. */
export interface Op {
  readonly op: string;
  readonly [member: string]: unknown;
}

export interface Diagnostic {
  readonly code: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly message: string;
  readonly elements: readonly string[];
  readonly location?: Record<string, unknown>;
  readonly fix?: readonly unknown[];
}

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly head: string | null;
}

export interface ChangesetView {
  readonly id: string;
  readonly name: string;
  readonly status: 'pending' | 'accepted' | 'rejected';
  readonly base: string;
  readonly head: string | null;
  readonly ops: number | null;
  readonly fastForward?: boolean | null;
  readonly mergeMode?: string | null;
  readonly mergedHash?: string | null;
}

export interface Committed {
  readonly status: 'committed';
  readonly head: string;
  readonly before: string;
  readonly hash: string;
  readonly op: { readonly id: string; readonly seq: number; readonly kind: string };
  readonly resolved: readonly Op[];
  readonly created: readonly string[];
  readonly removed: readonly string[];
  /** The changeset the batch went into; null (or absent) when it was committed to main. */
  readonly changeset?: ChangesetView | null;
}

export interface Model {
  readonly hash: string;
  readonly document: unknown;
  /** The canonical bytes, as the server sent them. */
  readonly text: string;
}

export interface ApplyInput {
  readonly batch: readonly Op[];
  readonly locks?: readonly unknown[];
  /** The design option the batch edits in (Ops 0.3, 2.8: `context.option`). */
  readonly option?: string;
  readonly changeset?: string;
  readonly ifMatch?: string;
}

export interface Validation {
  readonly head: string;
  readonly hash: string;
  readonly valid: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

/** A rule a finding cites: code, edition and section (Floorspec Rules 3.2). */
export interface FindingCitation {
  readonly code: string;
  readonly edition: string;
  readonly section: string;
  readonly link?: string;
}

/** One advisory finding (Floorspec Rules 9.2): what may not meet which rule, never a verdict. */
export interface Finding {
  readonly pack: string;
  readonly version: string;
  readonly rule: string;
  readonly title: string;
  readonly citation: FindingCitation;
  readonly severity: 'mayNotMeet' | 'check' | 'note';
  readonly subject: { readonly kind: string; readonly id: string; readonly envelope?: string };
  readonly elements: readonly string[];
  readonly message: string;
  readonly measures?: readonly unknown[];
  readonly location?: unknown;
  readonly candidates?: readonly unknown[];
}

/**
 * `GET /findings`: the installed rule packs evaluated against a head. With none installed, no
 * findings and a note saying so; with packs, the report's notice as `note` (and `notice`), and what
 * was evaluated, not evaluated, covered and diagnosed (Floorspec Rules 9.1).
 */
export interface Findings {
  readonly head: string;
  readonly hash: string;
  readonly findings: readonly Finding[];
  readonly rulePacks: readonly { readonly name: string; readonly version: string; readonly title: string }[];
  readonly note: string;
  readonly notice?: string;
  /** The jurisdiction profile the findings were evaluated under (FLR-T-6.8), and its ID — null for the default. */
  readonly profile?: string;
  readonly profileId?: string | null;
  /** Where the installed packs' coverage matrix is shown: what is checked, what is not (FLR-REQ-096). */
  readonly coverageUrl?: string;
  readonly diagnostics?: readonly { readonly code: string; readonly severity: string; readonly pack?: string; readonly rule?: string }[];
  readonly evaluated?: readonly { readonly pack: string; readonly version: string; readonly rule: string; readonly citation: FindingCitation; readonly subjects: number; readonly exempt: number; readonly findings: number }[];
  readonly notEvaluated?: readonly { readonly pack: string; readonly version: string; readonly rule: string; readonly reason: string }[];
  readonly coverage?: readonly unknown[];
}

/** What `POST /layouts` takes: where to lay the brief out, and how many candidates. */
export interface LayoutsInput {
  /** A pending changeset's ID whose head holds the brief; absent, main. */
  readonly changeset?: string;
  readonly level?: string;
  readonly footprint?: { readonly width: number | string; readonly depth: number | string };
  readonly count?: number;
}

/** One layout candidate as the API answers it: the solver's report, and the changeset it became. */
export interface LayoutCandidate {
  readonly rank: number;
  readonly label: string;
  readonly level: string;
  readonly footprint: { readonly width: number; readonly depth: number };
  readonly score: { readonly total: number; readonly briefFit: number; readonly circulation: number; readonly findings: number };
  readonly explanation: readonly string[];
  readonly unplaced: readonly { readonly item: string; readonly count: number; readonly reason: string }[];
  readonly changeset: ChangesetView;
  readonly reused: boolean;
}

export interface Layouts {
  readonly solved: { readonly main: string; readonly items: number; readonly adjacencies: number; readonly brief?: { readonly changeset: string; readonly name: string; readonly ops: number } };
  readonly candidates: readonly LayoutCandidate[];
}

export interface ElectricalInput {
  /** A pending changeset's ID whose plan to read instead of main's. */
  readonly changeset?: string;
  readonly rooms?: readonly string[];
  readonly level?: string;
}

/** The electrical assistant's answer (FLR-T-5.8): its proposal, and the changeset it became — none when there was nothing to add. */
export interface ElectricalProposal {
  readonly main: string;
  readonly changeset: ChangesetView | null;
  /** The pending changeset whose plan it read, and whose operations it carries. */
  readonly carries?: { readonly changeset: string; readonly name: string; readonly ops: number };
  readonly proposal: {
    readonly name: string;
    readonly explanation: readonly string[];
    readonly added: { readonly receptacles: readonly string[]; readonly switches: readonly string[]; readonly lights: readonly string[]; readonly panels?: readonly string[] };
    readonly circuits: readonly { readonly id: string; readonly name: string; readonly loads: readonly string[] }[];
    readonly notes: readonly string[];
    readonly ops: number;
  };
}

export interface FloorspecClient {
  listProjects(): Promise<readonly ProjectSummary[]>;
  /** A new, empty project owned by the caller's account. */
  createProject(name: string): Promise<ProjectSummary>;
  model(projectId: string, changeset?: string): Promise<Model>;
  apply(projectId: string, input: ApplyInput): Promise<Committed>;
  propose(projectId: string, input: { name: string; batch?: readonly Op[]; locks?: readonly unknown[] }): Promise<{ changeset: ChangesetView; applied: Committed | null }>;
  changesets(projectId: string): Promise<readonly ChangesetView[]>;
  accept(projectId: string, changesetId: string): Promise<{ changeset: ChangesetView; mode: string; hash: string; merged: readonly number[] }>;
  reject(projectId: string, changesetId: string): Promise<{ changeset: ChangesetView }>;
  proposeLayouts(projectId: string, input: LayoutsInput): Promise<Layouts>;
  proposeElectrical(projectId: string, input: ElectricalInput): Promise<ElectricalProposal>;
  validate(projectId: string, changeset?: string): Promise<Validation>;
  findings(projectId: string, changeset?: string): Promise<Findings>;
  render(projectId: string, options: RenderOptions): Promise<Uint8Array>;
  /**
   * Upload a file into the project's asset store (`POST /assets?as=model|symbol`): stored by its
   * SHA-256, readable by the project. Uploading the same bytes again changes nothing.
   */
  uploadAsset(projectId: string, upload: AssetUpload): Promise<StoredAsset>;
}

export interface AssetUpload {
  readonly bytes: Uint8Array;
  /** The file's name, for a person. */
  readonly name: string;
  readonly as: 'model' | 'symbol' | 'texture';
}

/** An uploaded file as the asset route answers it (apps/server/src/routes/assets.ts). */
export interface StoredAsset {
  readonly sha256: string;
  readonly mediaType: string;
  readonly byteLength: number;
  /** Where the document's asset entry should say it is (Core 18.4). */
  readonly path: string;
}

export interface RenderOptions {
  readonly view: 'plan' | '3d';
  /** 3D: a named view (FLR-T-8.5). */
  readonly camera?: 'sw' | 'se' | 'ne' | 'nw' | 'top';
  /** 3D: stand in this room, by ID or name. */
  readonly room?: string;
  readonly level?: string;
  /** A pending changeset: drawn ghosted against its base. */
  readonly changeset?: string;
  /** Element IDs drawn in the accent colour. */
  readonly highlight?: readonly string[];
  readonly width?: number;
  /** 3D: the luminaires on or off, path-traced at night (FLR-T-12.22). */
  readonly lights?: 'on' | 'off';
}

/** An answer from the API that is not a success: its status and its (problem+json) body. */
export class FloorspecApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(typeof body['error'] === 'string' ? body['error'] : typeof body['title'] === 'string' ? body['title'] : `the API answered ${String(status)}`);
    this.name = 'FloorspecApiError';
  }

  get diagnostics(): readonly Diagnostic[] {
    const value = this.body['diagnostics'];
    return Array.isArray(value) ? (value as Diagnostic[]) : [];
  }
}

export interface HttpClientOptions {
  /** The API's origin, e.g. `http://127.0.0.1:3400` for the loopback. */
  readonly baseUrl: string;
  /** The caller's `Authorization` header value, forwarded as it arrived. */
  readonly authorization: string;
  readonly fetch?: typeof fetch;
}

/** The REST client the remote MCP endpoint uses. */
export class HttpFloorspecClient implements FloorspecClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async send(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const raw = body instanceof Uint8Array;
    const res = await this.fetchImpl(new URL(path, this.options.baseUrl), {
      method,
      headers: {
        authorization: this.options.authorization,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': raw ? 'application/octet-stream' : 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
    });
    if (!res.ok) {
      const text = await res.text();
      let parsed: Record<string, unknown>;
      try {
        parsed = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        parsed = { error: text.slice(0, 500) };
      }
      throw new FloorspecApiError(res.status, parsed);
    }
    return res;
  }

  private async json<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    const res = await this.send(method, path, body, headers);
    return (await res.json()) as T;
  }

  private project(projectId: string, rest = ''): string {
    return `/api/projects/${encodeURIComponent(projectId)}${rest}`;
  }

  private query(changeset?: string): string {
    return changeset === undefined ? '' : `?changeset=${encodeURIComponent(changeset)}`;
  }

  async listProjects(): Promise<readonly ProjectSummary[]> {
    return (await this.json<{ projects: ProjectSummary[] }>('GET', '/api/projects')).projects;
  }

  createProject(name: string): Promise<ProjectSummary> {
    return this.json<ProjectSummary>('POST', '/api/projects', { name });
  }

  async model(projectId: string, changeset?: string): Promise<Model> {
    const path = changeset === undefined ? this.project(projectId, '/model.json') : this.project(projectId, `/changesets/${encodeURIComponent(changeset)}/model.json`);
    const res = await this.send('GET', path);
    const text = await res.text();
    return { hash: (res.headers.get('etag') ?? '').replace(/"/g, ''), document: JSON.parse(text) as unknown, text };
  }

  apply(projectId: string, input: ApplyInput): Promise<Committed> {
    return this.json<Committed>(
      'POST',
      this.project(projectId, '/ops'),
      {
        batch: input.batch,
        ...(input.locks === undefined && input.option === undefined
          ? {}
          : { context: { ...(input.locks === undefined ? {} : { locks: input.locks }), ...(input.option === undefined ? {} : { option: input.option }) } }),
        ...(input.changeset === undefined ? {} : { changeset: input.changeset }),
      },
      input.ifMatch === undefined ? {} : { 'if-match': `"${input.ifMatch}"` },
    );
  }

  propose(projectId: string, input: { name: string; batch?: readonly Op[]; locks?: readonly unknown[] }) {
    return this.json<{ changeset: ChangesetView; applied: Committed | null }>('POST', this.project(projectId, '/changesets'), {
      name: input.name,
      ...(input.batch === undefined ? {} : { batch: input.batch }),
      ...(input.locks === undefined ? {} : { context: { locks: input.locks } }),
    });
  }

  async changesets(projectId: string): Promise<readonly ChangesetView[]> {
    return (await this.json<{ changesets: ChangesetView[] }>('GET', this.project(projectId, '/changesets'))).changesets;
  }

  accept(projectId: string, changesetId: string) {
    return this.json<{ changeset: ChangesetView; mode: string; hash: string; merged: number[] }>('POST', this.project(projectId, `/changesets/${encodeURIComponent(changesetId)}/accept`), {});
  }

  reject(projectId: string, changesetId: string) {
    return this.json<{ changeset: ChangesetView }>('POST', this.project(projectId, `/changesets/${encodeURIComponent(changesetId)}/reject`), {});
  }

  proposeLayouts(projectId: string, input: LayoutsInput): Promise<Layouts> {
    return this.json<Layouts>('POST', this.project(projectId, '/layouts'), input);
  }

  proposeElectrical(projectId: string, input: ElectricalInput): Promise<ElectricalProposal> {
    return this.json<ElectricalProposal>('POST', this.project(projectId, '/assistants/electrical'), input);
  }

  validate(projectId: string, changeset?: string): Promise<Validation> {
    return this.json<Validation>('GET', this.project(projectId, `/validate${this.query(changeset)}`));
  }

  findings(projectId: string, changeset?: string): Promise<Findings> {
    return this.json<Findings>('GET', this.project(projectId, `/findings${this.query(changeset)}`));
  }

  async render(projectId: string, options: RenderOptions): Promise<Uint8Array> {
    const params = new URLSearchParams({ view: options.view });
    if (options.camera !== undefined) params.set('camera', options.camera);
    if (options.room !== undefined) params.set('room', options.room);
    if (options.level !== undefined) params.set('level', options.level);
    if (options.changeset !== undefined) params.set('changeset', options.changeset);
    if (options.highlight !== undefined && options.highlight.length > 0) params.set('highlight', options.highlight.join(','));
    if (options.width !== undefined) params.set('width', String(options.width));
    if (options.lights !== undefined) params.set('lights', options.lights);
    const res = await this.send('GET', this.project(projectId, `/render?${params.toString()}`), undefined, { accept: 'image/png' });
    return new Uint8Array(await res.arrayBuffer());
  }

  async uploadAsset(projectId: string, upload: AssetUpload): Promise<StoredAsset> {
    const path = this.project(projectId, `/assets?as=${encodeURIComponent(upload.as)}`);
    return (await this.json<{ asset: StoredAsset }>('POST', path, upload.bytes, { 'x-asset-name': encodeURIComponent(upload.name) })).asset;
  }
}
