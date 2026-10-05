import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apply } from '@floorspec/ops';
import houseText from '../src/projects/templates/three-room-house.floorspec.json?raw';
import { readModel, type EditorModel } from '../src/editor/model';
import { diffModels, groupChanges, roomEffects } from '../src/editor/diff';
import { describeOp, summarizeBatch } from '../src/editor/describe';
import { accept, needsRebase, openReview, rebase, replay, reviewTarget } from '../src/editor/review';
import { connectLive } from '../src/editor/live';
import { authorOf, versionsOf } from '../src/editor/history';
import { nudgeBatch } from '../src/editor/nudge';
import { interiorPoint } from '../src/editor/geometry';
import { BASE_PER_FOOT, BASE_PER_INCH, parsePoint, parseSegment } from '../src/editor/units';
import { EditorStore } from '../src/editor/store';
import { COMMANDS, commandFor } from '../src/editor/commands';
import type { ChangesetLogEntry, HistoryEntry } from '../src/editor/api';
import type { EventSourceLike } from '../src/lib/events';
import type { Batch } from '../src/editor/ops';

/**
 * The editor's second round (FLR-T-3.5, 3.6, 3.7): the plan diff, op descriptions, the rebase
 * replay, nudging, typed coordinates, and the live wiring — the last against a fake event stream
 * and a fake API, so what the editor does on each event is pinned without a server.
 */

const FT = BASE_PER_FOOT;
const IN = BASE_PER_INCH;

const house = (): EditorModel => readModel('h0', houseText);

/** Apply a batch with the real applier and read the result. */
function step(model: EditorModel, batch: Batch): { model: EditorModel; resolved: Record<string, unknown>[]; created: string[] } {
  const r = apply(model.document, { batch });
  if (r.status !== 'committed') throw new Error(r.diagnostics.map((d) => d.code).join(','));
  return { model: readModel(r.hash, r.document), resolved: r.resolved as unknown as Record<string, unknown>[], created: r.created };
}

// ─── The diff (FLR-T-3.6) ────────────────────────────────────────────────────────────────────

describe('diffing two versions by element ID', () => {
  it('calls a version against itself the same, with no changes', () => {
    const m = house();
    const d = diffModels(m, m, 'imperial');
    expect(d.changes).toEqual([]);
    expect(d.same).toBe(true);
  });

  it('finds a moved wall, the walls and rooms it reshaped, and says by how much', () => {
    const a = house();
    const b = step(a, [{ op: 'moveWall', wall: 'WI2', by: `2'` }]).model;
    const d = diffModels(a, b, 'imperial');
    expect(d.counts.added).toBe(0);
    expect(d.counts.removed).toBe(0);
    const moved = d.changes.filter((c) => c.kind === 'moved').map((c) => c.id);
    expect(moved).toEqual(expect.arrayContaining(['WI2', 'WE1', 'WE2', 'BED', 'KIT']));
    expect(d.changes.find((c) => c.id === 'WI2')?.detail).toBe(`moved 2'-0"`);
    // The junctions moved with their walls; the walls say it.
    expect(d.changes.some((c) => c.collection === 'junctions')).toBe(false);
    expect(d.ids.moved.has('TM')).toBe(true);
    expect(groupChanges(d).map((g) => g.kind)).toEqual(['moved']);
    const effects = roomEffects(a, b, 'imperial');
    expect(effects.map((e) => e.id)).toEqual(expect.arrayContaining(['BED', 'KIT']));
  });

  it('tells added from removed from changed', () => {
    const a = house();
    const b = step(a, [
      { op: 'addOpening', wall: 'WI2', at: `3'`, width: `3'`, height: `7'` },
      { op: 'removeElement', id: 'KW' },
      { op: 'setProperty', id: 'KIT', path: '/name', value: 'Galley' },
    ]).model;
    const d = diffModels(a, b, 'imperial');
    expect([...d.ids.added]).toHaveLength(1);
    expect(d.changes.find((c) => c.kind === 'removed')?.id).toBe('KW');
    expect(d.changes.find((c) => c.kind === 'changed')?.id).toBe('KIT');
    expect(d.changes.find((c) => c.kind === 'changed')?.label).toBe('Galley');
    expect(d.counts).toEqual({ added: 1, removed: 1, moved: 0, changed: 1 });
  });
});

// ─── Ops in words ────────────────────────────────────────────────────────────────────────────

describe('operations in words', () => {
  const name = (id: string) => (id === 'WI2' ? 'Wall WI2' : id);
  it('names an op and its target', () => {
    expect(describeOp({ op: 'moveWall', wall: 'WI2', by: 6 * IN }, 'imperial', name)).toEqual(['moveWall', `Wall WI2 · +6"`]);
    expect(describeOp({ op: 'drawWall', level: 'L1', from: [0, 0], to: [20 * FT, 0] }, 'imperial', name)[1]).toBe(`0", 0" → 20'-0", 0"`);
    expect(describeOp({ op: 'addElement', collection: 'levels', element: { name: 'Level 2' } }, 'imperial', name)).toEqual(['addElement', 'level “Level 2”']);
  });
  it('sums a batch up in a line', () => {
    const four = Array.from({ length: 4 }, () => ({ op: 'drawWall', level: 'L1', from: [0, 0], to: [1, 0] }));
    expect(summarizeBatch(four, 'imperial', name)).toBe('Drew 4 walls');
    expect(summarizeBatch([{ op: 'moveWall', wall: 'WI2', by: IN }], 'imperial', name)).toBe(`Moved Wall WI2 +1"`);
    expect(summarizeBatch([{ op: 'createProject' }], 'imperial', name)).toBe('Created the project');
    // A type added for the wall that uses it is the means, not the edit.
    expect(summarizeBatch([{ op: 'addElement', collection: 'types', id: 'EXT26', element: {} }, ...four], 'imperial', name)).toBe('Drew 4 walls');
  });
  it('says who wrote an op: you, a token by name, or the agent', () => {
    const entry = (author: HistoryEntry['author']) => ({ author }) as HistoryEntry;
    expect(authorOf(entry({ kind: 'account', account: 'a', name: 'M', token: null }), new Map())).toEqual({ name: 'You', kind: 'you' });
    expect(authorOf(entry({ kind: 'token', account: 'a', name: null, token: 't1' }), new Map([['t1', 'CI']]))).toEqual({ name: 'CI', kind: 'token' });
    expect(authorOf(entry({ kind: 'agent', account: 'a', name: 'Claude Code', token: 't2' }), new Map())).toEqual({ name: 'Claude Code', kind: 'agent' });
  });
  it('lists every version main has been at, newest first', () => {
    const log = [
      { seq: 3, after: 'c', before: 'b' },
      { seq: 2, after: 'b', before: 'a' },
    ] as HistoryEntry[];
    expect(versionsOf(log).map((v) => v.label)).toEqual(['v3', 'v2', 'before']);
  });
});

// ─── Rebase review (FLR-T-3.5) ───────────────────────────────────────────────────────────────

function logOf(base: EditorModel, batches: Batch[]): { log: ChangesetLogEntry[]; head: EditorModel } {
  let m = base;
  const log: ChangesetLogEntry[] = [];
  for (const [i, batch] of batches.entries()) {
    const r = step(m, batch);
    log.push({ seq: i + 10, authorKind: 'agent', authorAgent: 'Claude Code', ops: batch as unknown as Record<string, unknown>[], resolved: r.resolved, created: r.created, removed: [], beforeHash: m.hash, afterHash: r.model.hash, createdAt: new Date().toISOString() });
    m = r.model;
  }
  return { log, head: m };
}

describe('replaying a changeset onto a main that moved', () => {
  it('lands the same when main did not move, and says which batch lands differently when it did', () => {
    const base = house();
    const { log } = logOf(base, [[{ op: 'moveWall', wall: 'WI2', by: `1'` }]]);
    const same = replay(base, log);
    expect(same.status).toBe('ok');
    if (same.status === 'ok') expect(same.differs).toEqual([]);
    const moved = step(base, [{ op: 'moveWall', wall: 'WI2', by: `6"` }]).model;
    const rebased = replay(moved, log);
    expect(rebased.status).toBe('ok');
    if (rebased.status === 'ok') {
      expect(rebased.differs).toEqual([0]);
      // 6" by main, then the agent's 1' on top.
      expect(rebased.model.document.junctions?.['TM']?.position).toEqual([base.document.junctions?.['TM']?.position[0], (base.document.junctions?.['TM']?.position[1] ?? 0) + 18 * IN]);
    }
  });

  it('stops at the batch that no longer applies, with its diagnostics', () => {
    const base = house();
    const { log } = logOf(base, [[{ op: 'setProperty', id: 'KIT', path: '/name', value: 'Galley' }], [{ op: 'moveOpening', opening: 'KW', at: 'centered' }]]);
    const main = step(base, [{ op: 'removeElement', id: 'KW' }]).model;
    const out = replay(main, log);
    expect(out.status).toBe('failed');
    if (out.status === 'failed') {
      expect(out.index).toBe(1);
      expect(out.diagnostics[0]?.code).toBe('FS-OPS-003');
    }
  });
});

// ─── Nudging and typed coordinates (FLR-T-3.7) ───────────────────────────────────────────────

describe('arrow-key nudges are the ops a drag would send', () => {
  const m = house();
  const level = m.levels[0];
  if (level === undefined) throw new Error('no level');
  it('moves a junction by the step in the arrow’s direction', () => {
    const tm = m.document.junctions?.['TM']?.position as [number, number];
    expect(nudgeBatch(level, m.document, 'TM', 'ArrowRight', IN)).toEqual([{ op: 'moveJunction', id: 'TM', to: [tm[0] + IN, tm[1]] }]);
  });
  it('moves a wall sideways only, toward the side the arrow points', () => {
    // WI2 runs east, so its left (exterior) side is north.
    expect(nudgeBatch(level, m.document, 'WI2', 'ArrowUp', FT)).toEqual([{ op: 'moveWall', wall: 'WI2', by: FT }]);
    expect(nudgeBatch(level, m.document, 'WI2', 'ArrowDown', FT)).toEqual([{ op: 'moveWall', wall: 'WI2', by: -FT }]);
    expect(nudgeBatch(level, m.document, 'WI2', 'ArrowRight', FT)).toBeNull();
  });
  it('slides an opening along its wall', () => {
    const o = level.openings.find((x) => x.id === 'BW');
    if (o === undefined) throw new Error('no BW');
    const host = level.walls.find((w) => w.id === o.wall);
    if (host === undefined) throw new Error('no host');
    const along = host.b[0] !== host.a[0] ? (host.b[0] > host.a[0] ? 'ArrowRight' : 'ArrowLeft') : host.b[1] > host.a[1] ? 'ArrowUp' : 'ArrowDown';
    const batch = nudgeBatch(level, m.document, 'BW', along, IN);
    expect(batch).toEqual([{ op: 'moveOpening', opening: 'BW', at: Number(m.document.openings?.['BW']?.['offset']) + IN }]);
    // A nudged edit applies.
    expect(apply(m.document, { batch: batch ?? [] }).status).toBe('committed');
  });
});

describe('typed coordinates while drawing', () => {
  it('reads a point, a length, and a length at an angle', () => {
    expect(parsePoint(`0, 0`, 'imperial')).toEqual({ ok: true, value: [0, 0] });
    expect(parsePoint(`20', 12'6"`, 'imperial')).toEqual({ ok: true, value: [20 * FT, 12 * FT + 6 * IN] });
    expect(parseSegment(`20'`, 'imperial')).toEqual({ ok: true, kind: 'length', length: 20 * FT, angle: null });
    expect(parseSegment(`12' < 90`, 'imperial')).toEqual({ ok: true, kind: 'length', length: 12 * FT, angle: 90 });
    expect(parseSegment(`3m@-90`, 'metric')).toEqual({ ok: true, kind: 'length', length: 3_840_000, angle: 270 });
    expect(parseSegment('1, 2', 'imperial')).toEqual({ ok: true, kind: 'point', point: [IN, 2 * IN] });
    expect(parsePoint('7', 'imperial').ok).toBe(false);
  });

  it('finds a point inside an unnamed space for a room', () => {
    const m = house();
    for (const f of m.levels[0]?.faces ?? []) expect(interiorPoint(f)).not.toBeNull();
  });
});

describe('the command registry the palette lists', () => {
  it('has every editor action, each with a unique ID, the palette on ⌘K and the history on H', () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['review.accept', 'review.reject', 'review.open', 'history.toggle', 'history.compareLast', 'edit.addDoor', 'edit.nameRoom', 'edit.rename', 'view.levelUp', 'model.newLevel', 'model.metric', 'edit.undo']) expect(ids).toContain(id);
    expect(commandFor('Mod+k')?.id).toBe('view.palette');
    expect(commandFor('h')?.id).toBe('history.toggle');
    expect(commandFor('F2')?.id).toBe('edit.rename');
  });
});

// ─── Live wiring, against a fake stream and a fake API ───────────────────────────────────────

class FakeSource implements EventSourceLike {
  readyState = 0;
  private readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close(): void {
    this.readyState = 2;
  }
  emit(type: string, data: unknown, id = '1-1'): void {
    for (const l of this.listeners.get(type) ?? []) l({ data: JSON.stringify(data), lastEventId: id } as MessageEvent<string>);
  }
}

const P = '01a10000-0000-7000-8000-000000000001';
const CS = '01a10000-0000-7000-8000-0000000000c5';

interface Api {
  main: EditorModel;
  versions: Map<string, EditorModel>;
  changeset: { log: ChangesetLogEntry[]; head: EditorModel; base: string } | null;
  accept: () => Response;
  calls: string[];
}

function fakeApi(): Api {
  const base = house();
  const api: Api = { main: base, versions: new Map([[base.hash, base]]), changeset: null, accept: () => new Response('{}', { status: 500 }), calls: [] };
  const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
  vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit): Promise<Response> => Promise.resolve(route(input, init))));
  function route(url: string, init?: RequestInit): Response {
    api.calls.push(`${init?.method ?? 'GET'} ${url}`);
    const path = url.replace(`/api/projects/${P}`, '');
    if (url === `/api/projects/${P}`) return json({ id: P, name: 'House', head: null, ops: 1 });
    if (path === '/model.json') return new Response(JSON.stringify(api.main.document), { headers: { etag: `"${api.main.hash}"` } });
    if (path.startsWith('/history')) return json({ head: api.main.hash, undo: null, redo: null, ops: [{ seq: 1 }] });
    if (path.startsWith('/versions/')) {
      const m = api.versions.get(path.slice('/versions/'.length));
      return m === undefined ? json({}, { status: 404 }) : new Response(JSON.stringify(m.document));
    }
    if (path === '/changesets') return json({ changesets: api.changeset === null ? [] : [{ id: CS, name: 'Bigger bedroom', status: 'pending', base: api.changeset.base, head: api.changeset.head.hash, ops: api.changeset.log.length, createdBy: 'Claude Code', createdAt: new Date().toISOString(), fastForward: api.changeset.base === api.main.hash }] });
    if (path === `/changesets/${CS}`) {
      const c = api.changeset;
      if (c === null) return json({}, { status: 404 });
      return json({ id: CS, name: 'Bigger bedroom', status: 'pending', base: c.base, head: c.head.hash, ops: c.log.length, createdBy: 'Claude Code', createdAt: new Date().toISOString(), fastForward: c.base === api.main.hash, main: api.main.hash, log: c.log });
    }
    if (path === `/changesets/${CS}/model.json`) return api.changeset === null ? json({}, { status: 404 }) : new Response(JSON.stringify(api.changeset.head.document), { headers: { etag: `"${api.changeset.head.hash}"` } });
    if (path === `/changesets/${CS}/accept`) return api.accept();
    return json({ error: `unrouted ${url}` }, { status: 404 });
  }
  return api;
}

/** The review, which the test has just made sure exists. */
function reviewOf(store: EditorStore) {
  const r = store.get().review;
  if (r === null) throw new Error('no review');
  return r;
}

const tick = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('the editor on the event stream', () => {
  let api: Api;
  let source: FakeSource;
  let store: EditorStore;
  let stop: () => void;
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (f: () => void) => setTimeout(f, 0));
    vi.stubGlobal('cancelAnimationFrame', (h: number) => { clearTimeout(h); });
    api = fakeApi();
    store = new EditorStore(P);
    stop = connectLive(store, { createEventSource: () => (source = new FakeSource()), fallbackMs: 60_000 });
  });
  afterEach(() => {
    stop();
    vi.unstubAllGlobals();
  });

  it('subscribes first and loads on ready', async () => {
    expect(store.get().status).toBe('loading');
    expect(api.calls).toEqual([]);
    source.emit('ready', { resumed: false, replayed: 0 });
    await tick();
    expect(store.get().status).toBe('ready');
    expect(store.get().model?.hash).toBe(api.main.hash);
    expect(store.get().live).toBe('live');
  });

  it('follows main when another tab moves it, keeping the tool', async () => {
    source.emit('ready', { resumed: false, replayed: 0 });
    await tick();
    store.set({ tool: 'wall' });
    const next = step(api.main, [{ op: 'moveWall', wall: 'WI2', by: `1'` }]).model;
    api.versions.set(next.hash, next);
    api.main = next;
    source.emit('head', { head: 'main', hash: next.hash, seq: 2, kind: 'apply', authorKind: 'account', author: 'a', changeset: null });
    await tick();
    expect(store.get().model?.hash).toBe(next.hash);
    expect(store.get().tool).toBe('wall');
  });

  it('shows an agent’s proposal over main as it arrives, and reviews the rebased diff once main has moved', async () => {
    source.emit('ready', { resumed: false, replayed: 0 });
    await tick();
    const { log, head } = logOf(api.main, [[{ op: 'moveWall', wall: 'WI2', by: `1'` }]]);
    api.changeset = { log, head, base: api.main.hash };
    source.emit('changeset', { id: CS, name: 'Bigger bedroom', status: 'pending', change: 'opened', head: `cs/${CS}`, hash: head.hash, base: api.main.hash, ops: 1, createdBy: 'Claude Code', mergeMode: null });
    await tick();
    const s = store.get();
    expect(s.side).toBe('review');
    expect(s.review?.name).toBe('Bigger bedroom');
    expect(reviewTarget(s.review, s.model)?.hash).toBe(head.hash);
    expect(needsRebase(reviewOf(store), s.model)).toBe(false);

    // The person edits main: the review rebases locally and asks twice before accepting.
    const moved = step(api.main, [{ op: 'moveWall', wall: 'WI2', by: `6"` }]).model;
    api.versions.set(moved.hash, moved);
    api.main = moved;
    source.emit('head', { head: 'main', hash: moved.hash, seq: 3, kind: 'apply', authorKind: 'account', author: 'a', changeset: null });
    await tick();
    const r = reviewOf(store);
    expect(needsRebase(r, store.get().model)).toBe(true);
    expect(r.rebased?.against).toBe(moved.hash);
    expect(r.rebased?.differs).toEqual([0]);
    await accept(store);
    expect(store.get().review?.confirming).toBe(true);
    expect(api.calls.some((c) => c.includes('/accept'))).toBe(false);

    // The server's replay fails (409): shown with its diagnostics, nothing merged.
    api.accept = () => new Response(JSON.stringify({ status: 409, detail: 'batch 1 of 1 was rejected', failedIndex: 0, diagnostics: [{ code: 'FS-INV-304', severity: 'error', message: 'overlap', elements: ['BD'], location: {} }] }), { status: 409 });
    await accept(store, true);
    const failed = reviewOf(store);
    expect(api.calls.filter((c) => c.endsWith('/accept'))).toHaveLength(1);
    expect(failed.failure?.source).toBe('server');
    expect(failed.failure?.diagnostics[0]?.elements).toEqual(['BD']);
    expect(store.get().model?.hash).toBe(moved.hash);
  });

  it('predicts a replay that will fail, and offers no accept', async () => {
    source.emit('ready', { resumed: false, replayed: 0 });
    await tick();
    const { log, head } = logOf(api.main, [[{ op: 'moveOpening', opening: 'KW', at: 'centered' }]]);
    api.changeset = { log, head, base: api.main.hash };
    await openReview(store, CS);
    const gone = step(api.main, [{ op: 'removeElement', id: 'KW' }]).model;
    api.versions.set(gone.hash, gone);
    await store.follow(gone.hash, 5);
    rebase(store);
    const r = reviewOf(store);
    expect(r.failure?.source).toBe('preview');
    expect(r.failure?.diagnostics[0]?.code).toBe('FS-OPS-003');
    await accept(store, true);
    expect(api.calls.some((c) => c.endsWith('/accept'))).toBe(false);
  });

  it('closes the review when the changeset is decided elsewhere, and reloads on resync', async () => {
    source.emit('ready', { resumed: false, replayed: 0 });
    await tick();
    const { log, head } = logOf(api.main, [[{ op: 'moveWall', wall: 'WI2', by: `1'` }]]);
    api.changeset = { log, head, base: api.main.hash };
    await openReview(store, CS);
    expect(store.get().review).not.toBeNull();
    source.emit('changeset', { id: CS, name: 'Bigger bedroom', status: 'rejected', change: 'rejected', head: `cs/${CS}`, hash: null, base: api.main.hash, ops: 1, createdBy: 'Claude Code', mergeMode: null });
    await tick();
    expect(store.get().review).toBeNull();
    const before = api.calls.filter((c) => c.endsWith('/model.json') && !c.includes('changesets')).length;
    source.emit('resync', { reason: 'gap' });
    await tick();
    expect(api.calls.filter((c) => c.endsWith('/model.json') && !c.includes('changesets')).length).toBe(before + 1);
  });
});
