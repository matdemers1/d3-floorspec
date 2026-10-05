import { describe, expect, it } from 'vitest';
import { EventHub, type StreamEvent } from '../../src/events/hub.js';
import { encode, MAX_PAYLOAD } from '../../src/events/publish.js';
import { frame } from '../../src/events/routes.js';
import type { ProjectEvent } from '../../src/events/types.js';

/**
 * The event hub's numbering, rings and resumption (FLR-T-3.5), without a database: notifications
 * are handed to `receive` as the listener would.
 */

const P = '01a10000-0000-7000-8000-000000000001';
const Q = '01a10000-0000-7000-8000-000000000002';

function head(projectId: string, seq: number): ProjectEvent {
  return {
    projectId,
    type: 'head',
    data: { head: 'main', hash: String(seq).padStart(64, '0'), seq, kind: 'apply', authorKind: 'account', author: 'a', changeset: null },
  };
}

function hub(options = {}) {
  return new EventHub('postgres://unused/never_test', options);
}

describe('the event hub', () => {
  it('numbers events across projects, delivers each to its own project only', () => {
    const h = hub();
    const p: StreamEvent[] = [];
    const q: StreamEvent[] = [];
    h.subscribe(P, (e) => p.push(e), null);
    h.subscribe(Q, (e) => q.push(e), null);
    h.receive(encode(head(P, 1)));
    h.receive(encode(head(Q, 1)));
    h.receive(encode(head(P, 2)));
    expect(p.map((e) => e.id)).toEqual([h.idOf(1), h.idOf(3)]);
    expect(q.map((e) => e.id)).toEqual([h.idOf(2)]);
    expect(p[0]).toMatchObject({ type: 'head', data: { seq: 1 } });
    expect(h.latestId).toBe(h.idOf(3));
  });

  it('ignores a payload that is not an event', () => {
    const h = hub();
    const seen: StreamEvent[] = [];
    h.subscribe(P, (e) => seen.push(e), null);
    for (const junk of ['not json', 'null', '{"v":2,"p":"x","t":"head","d":{}}', `{"v":1,"p":"${P}","t":"drop","d":{}}`]) h.receive(junk);
    expect(seen).toEqual([]);
    expect(h.latestId).toBe(h.idOf(0));
  });

  it('replays exactly what a project missed after a Last-Event-ID', () => {
    const h = hub();
    h.receive(encode(head(P, 1)));
    h.receive(encode(head(Q, 1)));
    h.receive(encode(head(P, 2)));
    h.receive(encode(head(P, 3)));
    const { resumption } = h.subscribe(P, () => undefined, h.idOf(2));
    expect(resumption).toEqual({ resumed: true, missed: [expect.objectContaining({ id: h.idOf(3) }), expect.objectContaining({ id: h.idOf(4) })] });
    // Q missed nothing after its own event, and a project with no events at all missed nothing.
    expect(h.subscribe(Q, () => undefined, h.idOf(2)).resumption).toEqual({ resumed: true, missed: [] });
    expect(h.subscribe('01a10000-0000-7000-8000-000000000009', () => undefined, h.idOf(0)).resumption).toEqual({ resumed: true, missed: [] });
  });

  it('refuses to resume an ID from another epoch, a future ID, or nonsense', () => {
    const h = hub();
    h.receive(encode(head(P, 1)));
    for (const id of [hub().idOf(1), h.idOf(2), 'nonsense', `${h.epoch}-`, `${h.epoch}-1e3`]) {
      expect(h.subscribe(P, () => undefined, id).resumption, id).toEqual({ resumed: false, reason: 'unknown-id' });
    }
  });

  it('cannot resume past what its ring dropped', () => {
    const h = hub({ ringSize: 2 });
    for (const seq of [1, 2, 3]) h.receive(encode(head(P, seq)));
    expect(h.subscribe(P, () => undefined, h.idOf(0)).resumption).toEqual({ resumed: false, reason: 'expired' });
    expect(h.subscribe(P, () => undefined, h.idOf(1)).resumption).toMatchObject({ resumed: true, missed: [{ id: h.idOf(2) }, { id: h.idOf(3) }] });
  });

  it('cannot resume past an evicted project, in any project', () => {
    const h = hub({ maxProjects: 1 });
    h.receive(encode(head(P, 1)));
    h.receive(encode(head(Q, 1)));
    // P's ring was evicted for Q's: what P had cannot be replayed.
    expect(h.subscribe(P, () => undefined, h.idOf(0)).resumption).toEqual({ resumed: false, reason: 'expired' });
    expect(h.subscribe(P, () => undefined, h.idOf(1)).resumption).toEqual({ resumed: true, missed: [] });
  });

  it('stops delivering once unsubscribed, and counts subscribers', () => {
    const h = hub();
    const seen: StreamEvent[] = [];
    const { unsubscribe } = h.subscribe(P, (e) => seen.push(e), null);
    expect(h.subscriberCount(P)).toBe(1);
    unsubscribe();
    unsubscribe();
    h.receive(encode(head(P, 1)));
    expect(seen).toEqual([]);
    expect(h.subscriberCount()).toBe(0);
  });

  it('ends every tracked stream on close', async () => {
    const h = hub();
    let ended = 0;
    h.track(() => (ended += 1));
    h.track(() => (ended += 1));
    await h.close();
    expect(ended).toBe(2);
    await expect(h.start()).rejects.toThrow(/closed/);
  });
});

describe('the wire', () => {
  it('frames an event as one id, one event name and one data line', () => {
    expect(frame({ id: 'abc-1', type: 'head', data: { name: 'two\nlines' } })).toBe('id: abc-1\nevent: head\ndata: {"name":"two\\nlines"}\n\n');
  });

  it('refuses a payload Postgres would not take, rather than failing the commit late', () => {
    const big: ProjectEvent = { ...head(P, 1), data: { ...head(P, 1).data, author: 'x'.repeat(MAX_PAYLOAD) } } as ProjectEvent;
    expect(() => encode(big)).toThrow(/too large/);
  });
});
