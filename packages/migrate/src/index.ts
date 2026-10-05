/**
 * @floorspec/migrate — the reference migrator of Floorspec Core 0.3, chapter 20 (FLR-REQ-150): a
 * document of 0.1 or 0.2 migrated to a later draft, byte for byte as the migration suite says, and
 * the Floorspec Ops batch that makes exactly the same change to a stored document (FLR-ADR-008:
 * every change is an Op).
 *
 * A migration is a function of the document and the target alone (20.1): it implements no
 * extension, knows none and reads no file. Each step makes the document declare the next draft and
 * moves, into the record `extras["floorspec:migration"]`, the members whose meaning that draft
 * changed — 0.1 → 0.2 the opaque `collections` of top-level extension data (20.4), 0.2 → 0.3 an
 * extension element's own `option` (20.5) — so that a reader of the target reads the migration
 * exactly as it reads the document (20.6). Isomorphic (FLR-ADR-010): the editor, the server, MCP and
 * the CLI run the same code.
 */
import { CORE_VERSION, contentHash, evaluate, parseJson, writePretty, type Diagnostic } from '@floorspec/engine';

export const PACKAGE_NAME = '@floorspec/migrate';

/** The drafts this migrator reads and writes, oldest first (20.1). */
export const DRAFTS = ['0.1', '0.2', '0.3'] as const;
export type Draft = (typeof DRAFTS)[number];

/** The member of a document's `extras` where a migration records what it moved (20.3). */
export const RECORD = 'floorspec:migration';

/** One moved member: where it was, as a JSON Pointer into the document the step was given, and its value. */
export interface MovedMember {
  pointer: string;
  value: unknown;
}

/** What one step moved (20.3). */
export interface MigrationRecord {
  from: Draft;
  to: Draft;
  moved: MovedMember[];
}

export type MigrationResult =
  | {
      status: 'migrated';
      diagnostics: [];
      /** The draft the document declared. */
      from: Draft;
      /** The migration, as a parsed value. */
      document: Record<string, unknown>;
      /** The migration, written as 20.1.1 says: members sorted, two spaces, a final line feed, no default omitted. */
      text: string;
      /** Its content hash (9.3). */
      hash: string;
      /** The records this migration appended, one per step that moved something, in order. */
      records: MigrationRecord[];
    }
  | { status: 'refused'; diagnostics: Diagnostic[] };

/** A migration a migrator refuses (20.2, 20.3.3), with its diagnostics. */
export class MigrationRefusedError extends Error {
  readonly diagnostics: Diagnostic[];
  constructor(diagnostics: Diagnostic[]) {
    super(`the document cannot be migrated: ${diagnostics.map((d) => `${d.code} ${d.message}`).join('; ')}`);
    this.diagnostics = diagnostics;
  }
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isDraft = (v: unknown): v is Draft => typeof v === 'string' && (DRAFTS as readonly string[]).includes(v);

const diagnostic = (code: string, message: string, pointer?: string): Diagnostic => ({
  code,
  severity: 'error',
  message,
  elements: [],
  location: pointer === undefined ? {} : { pointer },
});

/** An RFC 6901 JSON Pointer of member names. */
export const pointer = (...names: string[]): string => names.map((n) => '/' + n.replaceAll('~', '~0').replaceAll('/', '~1')).join('');

/** A deep copy of a JSON value. */
const copy = <T>(v: T): T => structuredClone(v);

/** A member a step moves: the member names from the document to the object that holds it, and its name. */
interface Move {
  at: string[];
  member: string;
}

/** The members one step moves (20.4.1, 20.5.1). */
const MOVES: Record<'0.1' | '0.2', (doc: Json) => Move[]> = {
  // 20.4.1: the member `collections` of every extension's top-level data that is an object with one.
  '0.1': (doc) =>
    Object.entries(isObject(doc.extensions) ? doc.extensions : {})
      .filter(([, data]) => isObject(data) && Object.hasOwn(data, 'collections'))
      .map(([name]) => ({ at: ['extensions', name], member: 'collections' })),
  // 20.5.1: the member `option` of every extension element (12.5) that has one.
  '0.2': (doc) => {
    const out: Move[] = [];
    for (const [name, data] of Object.entries(isObject(doc.extensions) ? doc.extensions : {})) {
      if (!isObject(data) || !isObject(data.collections)) continue;
      for (const [collection, elements] of Object.entries(data.collections)) {
        if (!isObject(elements)) continue;
        for (const [id, element] of Object.entries(elements))
          if (isObject(element) && Object.hasOwn(element, 'option')) out.push({ at: ['extensions', name, 'collections', collection, id], member: 'option' });
      }
    }
    return out;
  },
};

const NEXT: Record<'0.1' | '0.2', Draft> = { '0.1': '0.2', '0.2': '0.3' };

/**
 * One step (20.1), from the draft a document declares to the next: a new document and the record of
 * what it moved, when it moved anything. The document is not changed. Throws MigrationRefusedError
 * with FS-MIG-002 when it has to record and the document's `extras["floorspec:migration"]` is not an
 * array (20.3.3).
 */
export function step(document: Json): { document: Json; record?: MigrationRecord } {
  const from = document.floorspec;
  if (from !== '0.1' && from !== '0.2') throw new Error(`no step from ${String(from)}`);
  const to = NEXT[from];
  const out = copy(document);
  const paths = MOVES[from](out);
  let record: MigrationRecord | undefined;
  if (paths.length) {
    const extras = isObject(out.extras) ? out.extras : {};
    const before = extras[RECORD];
    if (Object.hasOwn(extras, RECORD) && !Array.isArray(before))
      throw new MigrationRefusedError([
        diagnostic('FS-MIG-002', `extras["${RECORD}"] is not an array, so the step from ${from} to ${to} has nowhere to record what it moves.`, pointer('extras', RECORD)),
      ]);
    const moved: MovedMember[] = paths.map(({ at, member }) => {
      let holder = out;
      for (const name of at) holder = holder[name] as Json;
      const value = holder[member];
      Reflect.deleteProperty(holder, member);
      return { pointer: pointer(...at, member), value };
    });
    moved.sort((a, b) => (a.pointer < b.pointer ? -1 : a.pointer > b.pointer ? 1 : 0)); // UTF-16 code units (20.3.1)
    record = { from, to, moved };
    out.extras = { ...extras, [RECORD]: [...((before as unknown[] | undefined) ?? []), record] };
  }
  out.floorspec = to;
  return record ? { document: out, record } : { document: out };
}

/**
 * The tiers 1 to 3 of 20.2.1 — as a validator implementing every extension and knowing none reports
 * them: FS-JSON-, FS-DOC-001, FS-SCH-001 — or the parsed document when it passes them.
 */
function read(input: string | Uint8Array | object): { value: Json } | { diagnostics: Diagnostic[] } {
  let value: unknown = input;
  if (typeof input === 'string' || input instanceof Uint8Array) {
    const parsed = parseJson(input);
    if (parsed.diagnostics.length) return { diagnostics: parsed.diagnostics };
    value = parsed.value;
  }
  // A migrator needs to implement no extension (20.2.2): read as one that implements the required ones.
  const required = isObject(value) && Array.isArray(value.extensionsRequired) ? value.extensionsRequired.filter((n): n is string => typeof n === 'string') : [];
  const ev = evaluate(input, { extensions: required });
  const early = ev.diagnostics.filter((d) => /^FS-(JSON|DOC|SCH)-/.test(d.code));
  if (early.length) return { diagnostics: early };
  return { value: value as Json };
}

/** The migration of a parsed, readable document to `to`, and the records it appended (20.1.2, 20.1.3). */
export function migrateValue(document: Json, to: Draft): { document: Json; records: MigrationRecord[] } {
  let doc = document;
  const records: MigrationRecord[] = [];
  while (doc.floorspec !== to) {
    const s = step(doc);
    doc = s.document;
    if (s.record) records.push(s.record);
  }
  return { document: doc === document ? copy(document) : doc, records };
}

/**
 * Migrate a document — a JSON text, its UTF-8 bytes, or a parsed value — to the draft `to` (Core 0.3,
 * chapter 20): migrated, with the migration's bytes and hash, or refused, with the diagnostics a
 * conformant migrator reports.
 */
export function migrate(input: string | Uint8Array | object, to: unknown = CORE_VERSION): MigrationResult {
  const r = read(input);
  if ('diagnostics' in r) return { status: 'refused', diagnostics: r.diagnostics };
  const declared = r.value.floorspec as Draft;
  if (!isDraft(to) || DRAFTS.indexOf(to) < DRAFTS.indexOf(declared))
    return {
      status: 'refused',
      diagnostics: [
        diagnostic(
          'FS-MIG-001',
          isDraft(to)
            ? `The document declares ${declared}; a migration never goes back to ${to}.`
            : `${JSON.stringify(to)} is not a draft this migrator implements (${DRAFTS.join(', ')}).`,
        ),
      ],
    };
  try {
    const { document, records } = migrateValue(r.value, to);
    return { status: 'migrated', diagnostics: [], from: declared, document, text: writePretty(document), hash: contentHash(document), records };
  } catch (e) {
    if (e instanceof MigrationRefusedError) return { status: 'refused', diagnostics: e.diagnostics };
    throw e;
  }
}

/** Whether a document declares a draft earlier than `to`, so that migrating it changes it. */
export function needsMigration(document: { floorspec?: unknown }, to: Draft = CORE_VERSION): boolean {
  return isDraft(document.floorspec) && DRAFTS.indexOf(document.floorspec) < DRAFTS.indexOf(to);
}

/** A primitive of the migration batch: Floorspec Ops 2.3 on `$document`. */
export type MigrationOp =
  | { op: 'unsetProperty'; id: '$document'; path: string }
  | { op: 'setProperty'; id: '$document'; path: string; value: unknown };

/**
 * The Floorspec Ops batch that migrates a stored document to `to` (Core 20.10): `unsetProperty` of
 * `$document` for every member a step moves, in the order the steps move them; `setProperty` of
 * `$document` `/extras/floorspec:migration` with the record, when anything moved; and `setProperty`
 * of `/floorspec`. Applied to the document, it commits exactly the migration's canonical form. Empty
 * when the document already declares `to`. Throws MigrationRefusedError when the migration is refused.
 */
export function migrationBatch(document: string | Uint8Array | object, to: Draft = CORE_VERSION): MigrationOp[] {
  const m = migrate(document, to);
  if (m.status === 'refused') throw new MigrationRefusedError(m.diagnostics);
  if (m.from === to) return [];
  const ops: MigrationOp[] = m.records.flatMap((r) => r.moved.map((x): MigrationOp => ({ op: 'unsetProperty', id: '$document', path: x.pointer })));
  if (m.records.length) {
    const extras = m.document.extras as Json;
    ops.push({ op: 'setProperty', id: '$document', path: pointer('extras', RECORD), value: extras[RECORD] });
  }
  ops.push({ op: 'setProperty', id: '$document', path: '/floorspec', value: to });
  return ops;
}
